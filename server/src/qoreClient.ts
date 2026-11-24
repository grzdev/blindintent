import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  type UnifiedAccount,
  fetchAuthNonce,
  fetchAuthenticators,
  fetchPqcStatus,
  fetchSpendingRules,
} from "@qorechain/sdk";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { QORE_CONFIG } from "./config.js";

export interface AmmPoolView {
  id: string;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  weightedAvgPrice: string;
  status: string;
}

export interface ChainTelemetry {
  chainId: string;
  evmChainId: number;
  latestHeight: number | null;
  activePrecompiles: string[];
  pqcVerifyActive: boolean;
  pqcKeyStatusActive: boolean;
  abstractAccountEnabled: boolean;
  ammPool3: AmmPoolView | null;
  liveEthUsdReference: number;
  rpcReachable: boolean;
}

export async function fetchChainTelemetry(): Promise<ChainTelemetry> {
  const base: ChainTelemetry = {
    chainId: QORE_CONFIG.chainId,
    evmChainId: QORE_CONFIG.evmChainId,
    latestHeight: null,
    activePrecompiles: [],
    pqcVerifyActive: false,
    pqcKeyStatusActive: false,
    abstractAccountEnabled: false,
    ammPool3: null,
    liveEthUsdReference: 3200,
    rpcReachable: false,
  };

  try {
    const [blockRes, evmParamsRes, aaConfigRes, poolsRes] = await Promise.all([
      fetch(`${QORE_CONFIG.restUrl}/cosmos/base/tendermint/v1beta1/blocks/latest`),
      fetch(`${QORE_CONFIG.restUrl}/cosmos/evm/vm/v1/params`),
      fetch(`${QORE_CONFIG.restUrl}/qorechain/abstractaccount/v1/config`),
      fetch(`${QORE_CONFIG.restUrl}/qorechain/amm/v1/pools`),
    ]);

    base.rpcReachable = blockRes.ok || evmParamsRes.ok;

    if (blockRes.ok) {
      const b = (await blockRes.json()) as { block?: { header?: { height?: string } } };
      const h = Number(b.block?.header?.height);
      if (Number.isFinite(h)) base.latestHeight = h;
    }

    if (evmParamsRes.ok) {
      const p = (await evmParamsRes.json()) as { params?: { active_static_precompiles?: string[] } };
      const list = p.params?.active_static_precompiles ?? [];
      base.activePrecompiles = list;
      const lowerList = list.map((a) => a.toLowerCase());
      base.pqcVerifyActive = lowerList.includes(QORE_CONFIG.precompiles.pqcVerify.toLowerCase());
      base.pqcKeyStatusActive = lowerList.includes(QORE_CONFIG.precompiles.pqcKeyStatus.toLowerCase());
    }

    if (aaConfigRes.ok) {
      const a = (await aaConfigRes.json()) as { config?: { enabled?: boolean } };
      base.abstractAccountEnabled = Boolean(a.config?.enabled);
    }

    if (poolsRes.ok) {
      const pl = (await poolsRes.json()) as {
        pools?: Array<{
          id: string;
          token_a: string;
          token_b: string;
          reserve_a: string;
          reserve_b: string;
          weighted_avg_price: string;
          status: string;
        }>;
      };
      const p3 = pl.pools?.find((p) => p.id === QORE_CONFIG.ammPoolEthUsdId);
      if (p3) {
        base.ammPool3 = {
          id: p3.id,
          tokenA: p3.token_a,
          tokenB: p3.token_b,
          reserveA: p3.reserve_a,
          reserveB: p3.reserve_b,
          weightedAvgPrice: p3.weighted_avg_price,
          status: p3.status,
        };
        // Adjust decimals delta: fETH has 18 decimals, fUSD has 6 decimals (10^12 ratio)
        const rEth = Number(p3.reserve_a) / 1e18;
        const rUsd = Number(p3.reserve_b) / 1e6;
        if (rEth > 0 && rUsd > 0) {
          base.liveEthUsdReference = Number((rUsd / rEth).toFixed(2));
        }
      }
    }
  } catch {
    // Keep offline defaults gracefully if RPC temporarily unreachable
  }

  return base;
}

export async function fetchAccountSequence(address: string): Promise<{
  exists: boolean;
  accountNumber: bigint;
  sequence: bigint;
}> {
  const res = await fetch(`${QORE_CONFIG.restUrl}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) {
    return { exists: false, accountNumber: 0n, sequence: 0n };
  }
  if (!res.ok) {
    throw new Error(`Account lookup HTTP ${res.status}`);
  }
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return {
    exists: true,
    accountNumber: BigInt(acc.account_number ?? "0"),
    sequence: BigInt(acc.sequence ?? "0"),
  };
}

export async function fetchAddressBalances(address: string): Promise<Array<{ denom: string; amount: string }>> {
  const res = await fetch(`${QORE_CONFIG.restUrl}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { balances?: Array<{ denom: string; amount: string }> };
  return body.balances ?? [];
}

export async function broadcastHybridMessages(
  acc: UnifiedAccount,
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
  opts: { mode?: "hybrid" | "classical"; gas?: string; feeAmount?: string } = {},
) {
  const seq = await fetchAccountSequence(acc.cosmos);
  if (!seq.exists) {
    throw new Error(`Account ${acc.cosmos} does not exist on ${QORE_CONFIG.chainId} yet (needs test QOR).`);
  }
  const signer = new EthNativeSigner(acc, {
    signMode: opts.mode ?? "hybrid",
    rest: QORE_CONFIG.restUrl,
  });
  const signBytesVersion = await signer.resolveSignBytesVersion(QORE_CONFIG.chainId);
  const signed = signer.sign({
    chainId: QORE_CONFIG.chainId,
    accountNumber: seq.accountNumber,
    sequence: seq.sequence,
    fee: {
      amount: [{ denom: "uqor", amount: opts.feeAmount ?? "120000" }],
      gas: opts.gas ?? "900000",
    },
    messages,
    signBytesVersion,
  });

  const transport = await StargateClient.connect(QORE_CONFIG.rpcUrl);
  try {
    const delivered = await transport.broadcastTx(signed.txRawBytes);
    if (delivered.code !== 0) {
      throw new Error(
        `Transaction ${delivered.transactionHash} failed (code ${delivered.code}): ${delivered.rawLog ?? "unknown error"}`,
      );
    }
    return {
      transactionHash: delivered.transactionHash,
      code: delivered.code,
      height: delivered.height,
      gasUsed: delivered.gasUsed,
      gasWanted: delivered.gasWanted,
      rawLog: delivered.rawLog,
      events: delivered.events.map((ev) => ({
        type: ev.type,
        attributes: ev.attributes.map((a) => ({ key: a.key, value: a.value })),
      })),
      msgResponses: delivered.msgResponses.map((m) => ({
        typeUrl: m.typeUrl,
        value: m.value,
      })),
    };
  } finally {
    transport.disconnect();
  }
}

export async function inspectParticipantReadiness(cosmosAddr: string, agentPubkeyBytes?: Uint8Array) {
  const [pqc, kem, auths, rules, authNonce] = await Promise.all([
    fetchPqcStatus({ rest: QORE_CONFIG.restUrl, address: cosmosAddr }).catch(() => null),
    fetchKemKey({ rest: QORE_CONFIG.restUrl, address: cosmosAddr }).catch(() => null),
    fetchAuthenticators({ rest: QORE_CONFIG.restUrl, address: cosmosAddr }).catch(() => []),
    fetchSpendingRules({ rest: QORE_CONFIG.restUrl, address: cosmosAddr }).catch(() => null),
    agentPubkeyBytes
      ? fetchAuthNonce({ rest: QORE_CONFIG.restUrl, address: cosmosAddr, pubkey: agentPubkeyBytes }).catch(() => null)
      : Promise.resolve(null),
  ]);

  return { pqc, kem, auths, rules, authNonce };
}
