import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";

const REST = process.env.QORE_REST_URL ?? "https://api-testnet.qore.host";
const RPC = process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host";
const CHAIN_ID = process.env.QORE_CHAIN_ID ?? "qorechain-diana";

async function loadDeployerAccount(): Promise<UnifiedAccount> {
  const mnemonic = process.env.DEPLOYER_MNEMONIC?.trim() || process.env.QORE_MNEMONIC?.trim();
  if (mnemonic) return deriveUnifiedAccount(mnemonic, 0);

  const key = process.env.DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
  const recoveryCode = process.env.QORE_PQC_RECOVERY_CODE?.trim();
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key) && recoveryCode) {
    return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode });
  }
  throw new Error("Set DEPLOYER_MNEMONIC (recommended) or DEPLOYER_PRIVATE_KEY + QORE_PQC_RECOVERY_CODE in .env");
}

async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) {
    throw new Error(`${address} is not yet funded on chain. Claim test QOR from https://dashboard.qorechain.io/faucet first.`);
  }
  if (!res.ok) throw new Error(`Account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

async function broadcast(
  acc: UnifiedAccount,
  mode: "hybrid" | "classical",
  messages: Parameters<EthNativeSigner["sign"]>[0]["messages"],
): Promise<string> {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber,
      sequence,
      fee: FEE,
      messages,
    });
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const acc = await loadDeployerAccount();
  if (cmd === "status") {
    console.log(`Deployer EVM:    ${acc.evm}`);
    console.log(`Deployer Cosmos: ${acc.cosmos}`);
    const pqc = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
    const mine = pqc.registered ? isRegisteredPqcKey(pqc, acc.pqc.publicKey) : false;
    console.log(`PQC status:      ${pqc.registered ? (mine ? "registered" : "registered (different key)") : "unregistered"}`);
    const win = await evmWindowStatus({ rest: REST, address: acc.cosmos });
    console.log(
      win.found
        ? `EVM window:      ${win.live ? "live" : "inactive"} (${win.remainingBlocks} blocks, ${win.remainingTxs} txs, ${win.remainingValue} uqor left)`
        : "EVM window:      none",
    );
    return;
  }

  if (cmd === "register") {
    const pqc = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
    if (pqc.registered) {
      console.log("PQC key already registered.");
      return;
    }
    const proofOfPossession = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
    const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
    console.log(`PQC register tx: ${await broadcast(acc, "classical", [msg])}`);
    return;
  }

  if (cmd === "open") {
    const blocks = BigInt(process.env.QORE_WINDOW_BLOCKS ?? "1200");
    const maxTxs = BigInt(process.env.QORE_WINDOW_TXS ?? "10");
    const perTx = evmWindowCost({ gas: 4_000_000n, maxFeePerGas: 250_000_000_000n });
    const maxValue = perTx * maxTxs;
    const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks, maxTxs, maxValue });
    console.log(`Window opened tx: ${await broadcast(acc, "hybrid", [msg])}`);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Expected status | register | open`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
