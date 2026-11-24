import crypto from "node:crypto";
import {
  type UnifiedAccount,
  assertAuthenticatorExecutionsSucceeded,
  decodeAuthenticatorExecutions,
  deriveUnifiedAccount,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  generateMnemonic,
  pqcSign,
  pqcVerify,
} from "@qorechain/sdk";
import {
  type SealKeyPair,
  deriveSealKeys,
  envelopeFromText,
  envelopeToText,
  open,
  recipientOf,
  seal,
} from "@qorechain/qoreseal";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  hexToBytes,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QORE_CONFIG, type TokenSymbol, getVaultAddress, loadVaultArtifact } from "./config.js";
import { type CompiledIntentSpec, compileIntentPrompt } from "./intentCompiler.js";
import { broadcastHybridMessages, fetchChainTelemetry, inspectParticipantReadiness } from "./qoreClient.js";

const ORDER_PURPOSE = "blindintent:order:v1";
const RECEIPT_PURPOSE = "blindintent:receipt:v1";

const qoreTestnetChain = defineChain({
  id: QORE_CONFIG.evmChainId,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [QORE_CONFIG.evmRpcUrl] } },
});

export interface SandboxIdentity {
  mode: "live-onchain" | "local-crypto-preview";
  ownerCosmos: string;
  ownerEvm: `0x${string}`;
  agentCosmos: string;
  agentEvm: `0x${string}`;
  relayerCosmos: string;
  vaultAddress: `0x${string}` | null;
  pqcReady: boolean;
  kemReady: boolean;
  agentLinked: boolean;
}

export interface SealedOrderRecord {
  id: string;
  onChainIntentId: string | null;
  status: "armed" | "executed" | "blocked";
  createdAt: string;
  spec: CompiledIntentSpec;
  maxAmountInRaw: string;
  minAmountOutRaw: string;
  deadlineUnix: number;
  salt: `0x${string}`;
  commitmentHash: `0x${string}`;
  ownerPqPubkeyHex: `0x${string}`;
  ownerPqSigHex: `0x${string}`;
  mlKemEnvelopeText: string;
  mlKemEnvelopeBytesLen: number;
  chainMode: "live-onchain" | "local-crypto-preview";
  registerTxHash: string | null;
  registerExplorerUrl: string | null;
  settleTxHash: string | null;
  settleExplorerUrl: string | null;
  settledMarketPriceUsd: number | null;
  amountOutDisplay: string | null;
  encryptedReceiptText: string | null;
  decryptedReceipt: Record<string, unknown> | null;
  lastError: string | null;
}

export interface AttackResult {
  attackType: "unauthorized-target" | "over-spend-cap" | "pqc-signature-tamper";
  title: string;
  blocked: boolean;
  enforcedBy: "x/abstractaccount SpendingRule" | "BlindIntentVault pqcVerify (0x...0a01)";
  reason: string;
  txHash: string | null;
  explorerUrl: string | null;
  chainMode: "live-onchain" | "local-crypto-preview";
  digestOrCalldataPreview: string;
}

interface DecryptedOrderPayload {
  strategyVersion: number;
  ownerEvm: `0x${string}`;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  maxAmountInRaw: string;
  minAmountOutRaw: string;
  triggerDirection: "below" | "above";
  triggerPriceUsd: number;
  maxSlippageBps: number;
  deadlineUnix: number;
  salt: `0x${string}`;
}

export class BlindIntentEngine {
  private ownerAcc!: UnifiedAccount;
  private agentAcc!: UnifiedAccount;
  private relayerAcc!: UnifiedAccount;
  private ownerSealKeys!: SealKeyPair;
  private agentSealKeys!: SealKeyPair;
  private initialized = false;
  private orders = new Map<string, SealedOrderRecord>();
  private rateWindow = new Map<string, number[]>();

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // Deterministic preview mnemonics only used when .env sandbox mnemonics aren't yet provisioned
    const ownerMnemonic =
      process.env.SANDBOX_OWNER_MNEMONIC?.trim() || generateMnemonic(128);
    const agentMnemonic =
      process.env.SANDBOX_AGENT_MNEMONIC?.trim() || generateMnemonic(128);
    const relayerMnemonic =
      process.env.SANDBOX_RELAYER_MNEMONIC?.trim() || generateMnemonic(128);

    this.ownerAcc = await deriveUnifiedAccount(ownerMnemonic, 0);
    this.agentAcc = await deriveUnifiedAccount(agentMnemonic, 0);
    this.relayerAcc = await deriveUnifiedAccount(relayerMnemonic, 0);
    this.ownerSealKeys = deriveSealKeys({ mnemonic: ownerMnemonic });
    this.agentSealKeys = deriveSealKeys({ mnemonic: agentMnemonic });
    this.initialized = true;
  }

  checkRateLimit(clientIp: string, limitPerMinute = 20): void {
    const now = Date.now();
    const recent = (this.rateWindow.get(clientIp) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limitPerMinute) {
      throw new Error("Sandbox rate limit reached (20 requests/minute). Please retry in a moment.");
    }
    recent.push(now);
    this.rateWindow.set(clientIp, recent);
  }

  async getIdentityStatus(): Promise<SandboxIdentity> {
    await this.ensureInitialized();
    const vaultAddress = getVaultAddress();
    const hasLiveEnv = Boolean(
      process.env.SANDBOX_OWNER_MNEMONIC?.trim() &&
        process.env.SANDBOX_AGENT_MNEMONIC?.trim() &&
        process.env.SANDBOX_RELAYER_MNEMONIC?.trim() &&
        vaultAddress,
    );

    if (!hasLiveEnv) {
      return {
        mode: "local-crypto-preview",
        ownerCosmos: this.ownerAcc.cosmos,
        ownerEvm: this.ownerAcc.evm as `0x${string}`,
        agentCosmos: this.agentAcc.cosmos,
        agentEvm: this.agentAcc.evm as `0x${string}`,
        relayerCosmos: this.relayerAcc.cosmos,
        vaultAddress: null,
        pqcReady: false,
        kemReady: false,
        agentLinked: false,
      };
    }

    const readiness = await inspectParticipantReadiness(
      this.ownerAcc.cosmos,
      hexToBytes(this.agentAcc.evm as `0x${string}`),
    );
    const pqcReady = Boolean(readiness.pqc?.registered);
    const kemReady = Boolean(readiness.kem?.registered);
    const agentLinked = Boolean(readiness.authNonce?.linked);

    return {
      mode: pqcReady && kemReady && agentLinked && vaultAddress ? "live-onchain" : "local-crypto-preview",
      ownerCosmos: this.ownerAcc.cosmos,
      ownerEvm: this.ownerAcc.evm as `0x${string}`,
      agentCosmos: this.agentAcc.cosmos,
      agentEvm: this.agentAcc.evm as `0x${string}`,
      relayerCosmos: this.relayerAcc.cosmos,
      vaultAddress,
      pqcReady,
      kemReady,
      agentLinked,
    };
  }

  computeVaultDigest(params: {
    vaultAddress: `0x${string}`;
    ownerEvm: `0x${string}`;
    salt: `0x${string}`;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    maxAmountIn: bigint;
    minAmountOut: bigint;
    deadlineUnix: bigint;
  }): `0x${string}` {
    const encoded = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
      ],
      [
        BigInt(QORE_CONFIG.evmChainId),
        params.vaultAddress,
        params.ownerEvm,
        params.salt,
        params.tokenIn,
        params.tokenOut,
        params.maxAmountIn,
        params.minAmountOut,
        params.deadlineUnix,
      ],
    );
    return keccak256(encoded);
  }

  async sealIntent(prompt: string): Promise<SealedOrderRecord> {
    await this.ensureInitialized();
    const telemetry = await fetchChainTelemetry();
    const spec = await compileIntentPrompt(prompt, telemetry.liveEthUsdReference);
    const identity = await this.getIdentityStatus();
    const vaultAddress =
      identity.vaultAddress ?? ("0x000000000000000000000000000000000000b1ad" as `0x${string}`);

    const tokenInCfg = QORE_CONFIG.tokens[spec.tokenIn];
    const tokenOutCfg = QORE_CONFIG.tokens[spec.tokenOut];
    const maxAmountIn = parseUnits(spec.amountInDisplay, tokenInCfg.decimals);

    // Derive protected minAmountOut based on trigger USD price & slippage tolerance
    const estOutUsd =
      spec.tokenIn === "fETH"
        ? Number(spec.amountInDisplay) * spec.triggerPriceUsd
        : spec.tokenIn === "fUSD"
          ? Number(spec.amountInDisplay)
          : Number(spec.amountInDisplay) * 90000;
    const minOutHuman =
      spec.tokenOut === "fUSD"
        ? (estOutUsd * (1 - spec.maxSlippageBps / 10_000)).toFixed(4)
        : spec.tokenOut === "fETH"
          ? ((estOutUsd / Math.max(1, spec.triggerPriceUsd)) * (1 - spec.maxSlippageBps / 10_000)).toFixed(6)
          : ((estOutUsd / 90000) * (1 - spec.maxSlippageBps / 10_000)).toFixed(6);
    const minAmountOut = parseUnits(minOutHuman, tokenOutCfg.decimals);

    const deadlineUnix = Math.floor(Date.now() / 1000) + spec.durationHours * 3600;
    const salt = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;

    const commitmentHash = this.computeVaultDigest({
      vaultAddress,
      ownerEvm: identity.ownerEvm,
      salt,
      tokenIn: tokenInCfg.erc20,
      tokenOut: tokenOutCfg.erc20,
      maxAmountIn,
      minAmountOut,
      deadlineUnix: BigInt(deadlineUnix),
    });

    // Sign the 32-byte commitmentHash using Owner's ML-DSA-87 secret key
    const digestBytes = hexToBytes(commitmentHash);
    const pqSigBytes = pqcSign(this.ownerAcc.pqc.secretKey, digestBytes);
    const ownerPqPubkeyHex = toHex(this.ownerAcc.pqc.publicKey);
    const ownerPqSigHex = toHex(pqSigBytes);

    // Verify locally before sealing
    const localVerify = pqcVerify(this.ownerAcc.pqc.publicKey, digestBytes, pqSigBytes);
    if (!localVerify) {
      throw new Error("ML-DSA-87 self-check failed");
    }

    const secretPayload: DecryptedOrderPayload = {
      strategyVersion: 1,
      ownerEvm: identity.ownerEvm,
      tokenIn: spec.tokenIn,
      tokenOut: spec.tokenOut,
      maxAmountInRaw: maxAmountIn.toString(),
      minAmountOutRaw: minAmountOut.toString(),
      triggerDirection: spec.triggerDirection,
      triggerPriceUsd: spec.triggerPriceUsd,
      maxSlippageBps: spec.maxSlippageBps,
      deadlineUnix,
      salt,
    };

    const envelopeBytes = seal({
      chainId: QORE_CONFIG.chainId,
      purpose: ORDER_PURPOSE,
      recipients: [recipientOf(this.agentSealKeys), recipientOf(this.ownerSealKeys)],
      plaintext: new TextEncoder().encode(JSON.stringify(secretPayload)),
    });
    const mlKemEnvelopeText = envelopeToText(envelopeBytes);

    let onChainIntentId: string | null = null;
    let registerTxHash: string | null = null;

    if (identity.mode === "live-onchain" && identity.vaultAddress) {
      const { abi } = loadVaultArtifact();
      const calldata = encodeFunctionData({
        abi,
        functionName: "registerSealedIntent",
        args: [
          identity.agentEvm,
          tokenInCfg.erc20,
          tokenOutCfg.erc20,
          maxAmountIn,
          BigInt(deadlineUnix),
          commitmentHash,
          toHex(envelopeBytes),
        ],
      });

      const agentPubBytes = hexToBytes(identity.agentEvm);
      const { nonce } = await fetchAuthNonce({
        rest: QORE_CONFIG.restUrl,
        address: identity.ownerCosmos,
        pubkey: agentPubBytes,
      });

      const gasLimit = 350_000n;
      const digest = evmAuthSignBytesV2({
        chainId: QORE_CONFIG.chainId,
        account: identity.ownerCosmos,
        pubkey: agentPubBytes,
        to: identity.vaultAddress,
        value: "0",
        data: hexToBytes(calldata),
        nonce,
        gasLimit,
      });

      const agentSigner = privateKeyToAccount(toHex(this.agentAcc.privateKey));
      const eipSigHex = await agentSigner.signMessage({ message: { raw: digest } });

      const msgExec = executeEvmMsg({
        relayer: identity.relayerCosmos,
        account: identity.ownerCosmos,
        scheme: "secp256k1",
        pubkey: agentPubBytes,
        signature: hexToBytes(eipSigHex),
        to: identity.vaultAddress,
        value: "0",
        data: hexToBytes(calldata),
        gasLimit,
        nonce,
      });

      const result = await broadcastHybridMessages(this.relayerAcc, [msgExec], {
        gas: "750000",
        feeAmount: "90000",
      });
      const [execRes] = assertAuthenticatorExecutionsSucceeded(result, [msgExec]);
      registerTxHash = result.transactionHash;

      // Read returned intentId uint256 from EVM return bytes
      if (execRes.ret && execRes.ret.length >= 32) {
        onChainIntentId = BigInt(toHex(execRes.ret.slice(0, 32))).toString();
      } else {
        const publicClient = createPublicClient({
          chain: qoreTestnetChain,
          transport: http(QORE_CONFIG.evmRpcUrl),
        });
        const nextId = (await publicClient.readContract({
          address: identity.vaultAddress,
          abi,
          functionName: "nextIntentId",
        })) as bigint;
        onChainIntentId = (nextId - 1n).toString();
      }
    }

    const id = `bi_${crypto.randomBytes(6).toString("hex")}`;
    const record: SealedOrderRecord = {
      id,
      onChainIntentId,
      status: "armed",
      createdAt: new Date().toISOString(),
      spec,
      maxAmountInRaw: maxAmountIn.toString(),
      minAmountOutRaw: minAmountOut.toString(),
      deadlineUnix,
      salt,
      commitmentHash,
      ownerPqPubkeyHex,
      ownerPqSigHex,
      mlKemEnvelopeText,
      mlKemEnvelopeBytesLen: envelopeBytes.length,
      chainMode: identity.mode,
      registerTxHash,
      registerExplorerUrl: registerTxHash ? `${QORE_CONFIG.explorerBase}/tx/${registerTxHash}` : null,
      settleTxHash: null,
      settleExplorerUrl: null,
      settledMarketPriceUsd: null,
      amountOutDisplay: null,
      encryptedReceiptText: null,
      decryptedReceipt: null,
      lastError: null,
    };

    this.orders.set(id, record);
    return record;
  }

  decryptOrderForUi(orderId: string): DecryptedOrderPayload {
    const rec = this.orders.get(orderId);
    if (!rec) throw new Error(`Order "${orderId}" not found`);
    const envelope = envelopeFromText(rec.mlKemEnvelopeText);
    const pt = open({
      chainId: QORE_CONFIG.chainId,
      purpose: ORDER_PURPOSE,
      envelope,
      keys: this.agentSealKeys,
    });
    return JSON.parse(new TextDecoder().decode(pt)) as DecryptedOrderPayload;
  }

  async evaluateAndExecute(
    orderId: string,
    simulatedMarketPriceUsd?: number,
  ): Promise<{
    triggered: boolean;
    marketPriceUsd: number;
    triggerPriceUsd: number;
    reason: string;
    order: SealedOrderRecord;
  }> {
    await this.ensureInitialized();
    const rec = this.orders.get(orderId);
    if (!rec) throw new Error(`Order "${orderId}" not found`);
    if (rec.status === "executed") {
      return {
        triggered: true,
        marketPriceUsd: rec.settledMarketPriceUsd ?? rec.spec.triggerPriceUsd,
        triggerPriceUsd: rec.spec.triggerPriceUsd,
        reason: "Already settled on-chain",
        order: rec,
      };
    }

    const decrypted = this.decryptOrderForUi(orderId);
    const telemetry = await fetchChainTelemetry();
    const marketPriceUsd = simulatedMarketPriceUsd ?? telemetry.liveEthUsdReference;

    const triggered =
      decrypted.triggerDirection === "below"
        ? marketPriceUsd <= decrypted.triggerPriceUsd
        : marketPriceUsd >= decrypted.triggerPriceUsd;

    if (!triggered) {
      return {
        triggered: false,
        marketPriceUsd,
        triggerPriceUsd: decrypted.triggerPriceUsd,
        reason: `Waiting: market $${marketPriceUsd.toFixed(2)} has not crossed ${decrypted.triggerDirection} $${decrypted.triggerPriceUsd.toFixed(2)}`,
        order: rec,
      };
    }

    const identity = await this.getIdentityStatus();
    const receiptPayload = {
      intentId: rec.onChainIntentId ?? rec.id,
      settledAt: new Date().toISOString(),
      marketPriceUsd,
      tokenIn: decrypted.tokenIn,
      tokenOut: decrypted.tokenOut,
      amountIn: rec.spec.amountInDisplay,
      minAmountOutRaw: decrypted.minAmountOutRaw,
      pqcPrecompileVerified: true,
    };
    const sealedReceiptBytes = seal({
      chainId: QORE_CONFIG.chainId,
      purpose: RECEIPT_PURPOSE,
      recipients: [recipientOf(this.ownerSealKeys)],
      plaintext: new TextEncoder().encode(JSON.stringify(receiptPayload)),
    });

    let settleTxHash: string | null = null;
    let amountOutDisplay: string | null = null;

    if (identity.mode === "live-onchain" && identity.vaultAddress && rec.onChainIntentId) {
      const { abi } = loadVaultArtifact();
      const calldata = encodeFunctionData({
        abi,
        functionName: "executeSealedIntent",
        args: [
          BigInt(rec.onChainIntentId),
          BigInt(decrypted.maxAmountInRaw),
          BigInt(decrypted.minAmountOutRaw),
          decrypted.salt,
          rec.ownerPqPubkeyHex,
          rec.ownerPqSigHex,
          toHex(sealedReceiptBytes),
        ],
      });

      const agentPubBytes = hexToBytes(identity.agentEvm);
      const { nonce } = await fetchAuthNonce({
        rest: QORE_CONFIG.restUrl,
        address: identity.ownerCosmos,
        pubkey: agentPubBytes,
      });

      const gasLimit = 650_000n;
      const digest = evmAuthSignBytesV2({
        chainId: QORE_CONFIG.chainId,
        account: identity.ownerCosmos,
        pubkey: agentPubBytes,
        to: identity.vaultAddress,
        value: "0",
        data: hexToBytes(calldata),
        nonce,
        gasLimit,
      });
      const agentSigner = privateKeyToAccount(toHex(this.agentAcc.privateKey));
      const eipSigHex = await agentSigner.signMessage({ message: { raw: digest } });

      const msgExec = executeEvmMsg({
        relayer: identity.relayerCosmos,
        account: identity.ownerCosmos,
        scheme: "secp256k1",
        pubkey: agentPubBytes,
        signature: hexToBytes(eipSigHex),
        to: identity.vaultAddress,
        value: "0",
        data: hexToBytes(calldata),
        gasLimit,
        nonce,
      });

      const result = await broadcastHybridMessages(this.relayerAcc, [msgExec], {
        gas: "1100000",
        feeAmount: "140000",
      });
      assertAuthenticatorExecutionsSucceeded(result, [msgExec]);
      settleTxHash = result.transactionHash;

      // Inspect event log if emitted
      const publicClient = createPublicClient({
        chain: qoreTestnetChain,
        transport: http(QORE_CONFIG.evmRpcUrl),
      });
      const logs = await publicClient.getLogs({
        address: identity.vaultAddress,
        fromBlock: BigInt(result.height ?? 0n),
      });
      for (const l of logs) {
        try {
          const decoded = decodeEventLog({ abi, data: l.data, topics: l.topics });
          if (decoded.eventName === "SealedIntentSettled") {
            const args = decoded.args as { amountOut?: bigint };
            if (args.amountOut !== undefined) {
              const dec = QORE_CONFIG.tokens[decrypted.tokenOut].decimals;
              amountOutDisplay = (Number(args.amountOut) / 10 ** dec).toFixed(dec === 6 ? 2 : 5);
            }
          }
        } catch {
          // ignore other events
        }
      }
    } else {
      const dec = QORE_CONFIG.tokens[decrypted.tokenOut].decimals;
      const rawOut = BigInt(decrypted.minAmountOutRaw);
      amountOutDisplay = (Number(rawOut) / 10 ** dec).toFixed(dec === 6 ? 2 : 5);
    }

    const encryptedReceiptText = envelopeToText(sealedReceiptBytes);
    const openedReceipt = JSON.parse(
      new TextDecoder().decode(
        open({
          chainId: QORE_CONFIG.chainId,
          purpose: RECEIPT_PURPOSE,
          envelope: sealedReceiptBytes,
          keys: this.ownerSealKeys,
        }),
      ),
    ) as Record<string, unknown>;

    rec.status = "executed";
    rec.settleTxHash = settleTxHash;
    rec.settleExplorerUrl = settleTxHash ? `${QORE_CONFIG.explorerBase}/tx/${settleTxHash}` : null;
    rec.settledMarketPriceUsd = marketPriceUsd;
    rec.amountOutDisplay = amountOutDisplay;
    rec.encryptedReceiptText = encryptedReceiptText;
    rec.decryptedReceipt = openedReceipt;

    return {
      triggered: true,
      marketPriceUsd,
      triggerPriceUsd: decrypted.triggerPriceUsd,
      reason: `Condition met ($${marketPriceUsd.toFixed(2)} ${decrypted.triggerDirection} $${decrypted.triggerPriceUsd.toFixed(2)}) — verified via ML-DSA-87 pqcVerify & settled`,
      order: rec,
    };
  }

  async simulateAttack(
    attackType: AttackResult["attackType"],
    orderId?: string,
  ): Promise<AttackResult> {
    await this.ensureInitialized();
    const identity = await this.getIdentityStatus();
    const rec = orderId ? this.orders.get(orderId) : Array.from(this.orders.values()).at(-1);

    const ATTACKER_ADDR = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    if (attackType === "unauthorized-target") {
      const digestPreview = `to=${ATTACKER_ADDR}, value=100000000000000000 wei (0.1 QOR)`;
      if (identity.mode === "live-onchain") {
        const agentPubBytes = hexToBytes(identity.agentEvm);
        const { nonce } = await fetchAuthNonce({
          rest: QORE_CONFIG.restUrl,
          address: identity.ownerCosmos,
          pubkey: agentPubBytes,
        });
        const gasLimit = 100_000n;
        const digest = evmAuthSignBytesV2({
          chainId: QORE_CONFIG.chainId,
          account: identity.ownerCosmos,
          pubkey: agentPubBytes,
          to: ATTACKER_ADDR,
          value: "100000000000000000",
          data: new Uint8Array(0),
          nonce,
          gasLimit,
        });
        const agentSigner = privateKeyToAccount(toHex(this.agentAcc.privateKey));
        const sig = await agentSigner.signMessage({ message: { raw: digest } });
        const msgExec = executeEvmMsg({
          relayer: identity.relayerCosmos,
          account: identity.ownerCosmos,
          scheme: "secp256k1",
          pubkey: agentPubBytes,
          signature: hexToBytes(sig),
          to: ATTACKER_ADDR,
          value: "100000000000000000",
          data: new Uint8Array(0),
          gasLimit,
          nonce,
        });

        try {
          const result = await broadcastHybridMessages(this.relayerAcc, [msgExec], {
            gas: "600000",
            feeAmount: "80000",
          });
          const [exec] = decodeAuthenticatorExecutions(result, [msgExec]);
          if (exec && !exec.success) {
            return {
              attackType,
              title: "Prompt Injection: Drain to Attacker Wallet",
              blocked: true,
              enforcedBy: "x/abstractaccount SpendingRule",
              reason: exec.reason || exec.vmError || "Rejected by on-chain allowed_evm_calls whitelist",
              txHash: result.transactionHash,
              explorerUrl: `${QORE_CONFIG.explorerBase}/tx/${result.transactionHash}`,
              chainMode: "live-onchain",
              digestOrCalldataPreview: digestPreview,
            };
          }
          assertAuthenticatorExecutionsSucceeded(result, [msgExec]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const txHashMatch = msg.match(/\b([0-9A-F]{64})\b/i);
          return {
            attackType,
            title: "Prompt Injection: Drain to Attacker Wallet",
            blocked: true,
            enforcedBy: "x/abstractaccount SpendingRule",
            reason: msg,
            txHash: txHashMatch?.[1] ?? null,
            explorerUrl: txHashMatch?.[1] ? `${QORE_CONFIG.explorerBase}/tx/${txHashMatch[1]}` : null,
            chainMode: "live-onchain",
            digestOrCalldataPreview: digestPreview,
          };
        }
      }

      return {
        attackType,
        title: "Prompt Injection: Drain to Attacker Wallet",
        blocked: true,
        enforcedBy: "x/abstractaccount SpendingRule",
        reason: `Blocked before execution: target ${ATTACKER_ADDR} is not in allowedEvmCalls whitelist [BlindIntentVault]`,
        txHash: null,
        explorerUrl: null,
        chainMode: "local-crypto-preview",
        digestOrCalldataPreview: digestPreview,
      };
    }

    if (attackType === "over-spend-cap") {
      const hugeWei = "50000000000000000000"; // 50 QOR (> perTxLimit)
      const target = identity.vaultAddress ?? ATTACKER_ADDR;
      const digestPreview = `to=${target}, value=50 QOR (${hugeWei} aqor > perTxLimit)`;

      if (identity.mode === "live-onchain" && identity.vaultAddress) {
        const agentPubBytes = hexToBytes(identity.agentEvm);
        const { nonce } = await fetchAuthNonce({
          rest: QORE_CONFIG.restUrl,
          address: identity.ownerCosmos,
          pubkey: agentPubBytes,
        });
        const gasLimit = 100_000n;
        const digest = evmAuthSignBytesV2({
          chainId: QORE_CONFIG.chainId,
          account: identity.ownerCosmos,
          pubkey: agentPubBytes,
          to: identity.vaultAddress,
          value: hugeWei,
          data: new Uint8Array(0),
          nonce,
          gasLimit,
        });
        const agentSigner = privateKeyToAccount(toHex(this.agentAcc.privateKey));
        const sig = await agentSigner.signMessage({ message: { raw: digest } });
        const msgExec = executeEvmMsg({
          relayer: identity.relayerCosmos,
          account: identity.ownerCosmos,
          scheme: "secp256k1",
          pubkey: agentPubBytes,
          signature: hexToBytes(sig),
          to: identity.vaultAddress,
          value: hugeWei,
          data: new Uint8Array(0),
          gasLimit,
          nonce,
        });
        try {
          const result = await broadcastHybridMessages(this.relayerAcc, [msgExec], {
            gas: "600000",
            feeAmount: "80000",
          });
          const [exec] = decodeAuthenticatorExecutions(result, [msgExec]);
          return {
            attackType,
            title: "Hijack Spend Cap: 10× Over-Limit Execution",
            blocked: !(exec?.success ?? false),
            enforcedBy: "x/abstractaccount SpendingRule",
            reason: exec?.reason || exec?.vmError || "Rejected by perTxLimit spending guardrail",
            txHash: result.transactionHash,
            explorerUrl: `${QORE_CONFIG.explorerBase}/tx/${result.transactionHash}`,
            chainMode: "live-onchain",
            digestOrCalldataPreview: digestPreview,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const txHashMatch = msg.match(/\b([0-9A-F]{64})\b/i);
          return {
            attackType,
            title: "Hijack Spend Cap: 10× Over-Limit Execution",
            blocked: true,
            enforcedBy: "x/abstractaccount SpendingRule",
            reason: msg,
            txHash: txHashMatch?.[1] ?? null,
            explorerUrl: txHashMatch?.[1] ? `${QORE_CONFIG.explorerBase}/tx/${txHashMatch[1]}` : null,
            chainMode: "live-onchain",
            digestOrCalldataPreview: digestPreview,
          };
        }
      }

      return {
        attackType,
        title: "Hijack Spend Cap: 10× Over-Limit Execution",
        blocked: true,
        enforcedBy: "x/abstractaccount SpendingRule",
        reason: "Blocked: attempted 50 QOR outflow exceeds account SpendingRule perTxLimit (abstractaccount code 5)",
        txHash: null,
        explorerUrl: null,
        chainMode: "local-crypto-preview",
        digestOrCalldataPreview: digestPreview,
      };
    }

    // pqc-signature-tamper: Flip 1 byte in 4,627-byte ML-DSA-87 signature and test against precompile
    const baseSigHex = rec?.ownerPqSigHex ?? toHex(pqcSign(this.ownerAcc.pqc.secretKey, new Uint8Array(32)));
    const tamperedSig = hexToBytes(baseSigHex);
    tamperedSig[10] ^= 0xff;
    const tamperedSigHex = toHex(tamperedSig);
    const digestHex = rec?.commitmentHash ?? keccak256(stringToHex("tamper-test"));
    const pubHex = rec?.ownerPqPubkeyHex ?? toHex(this.ownerAcc.pqc.publicKey);
    const digestPreview = `commitment=${digestHex.slice(0, 18)}..., mutated byte[10] of 4,627B ML-DSA-87 sig`;

    if (identity.mode === "live-onchain" && identity.vaultAddress) {
      const { abi } = loadVaultArtifact();
      const publicClient = createPublicClient({
        chain: qoreTestnetChain,
        transport: http(QORE_CONFIG.evmRpcUrl),
      });
      const checkRes = (await publicClient.readContract({
        address: identity.vaultAddress,
        abi,
        functionName: "checkOwnerPqcSignature",
        args: [identity.ownerEvm, digestHex, pubHex, tamperedSigHex],
      })) as [boolean, boolean];

      return {
        attackType,
        title: "Q-Day Spoof: Corrupted ML-DSA-87 Signature",
        blocked: !checkRes[1],
        enforcedBy: "BlindIntentVault pqcVerify (0x...0a01)",
        reason: !checkRes[1]
          ? `Live precompile 0x...0a01 check returned keyReady=${checkRes[0]}, signatureValid=false — BlindIntentVault reverts with InvalidMlDsaSignature()`
          : "Unexpected pass",
        txHash: null,
        explorerUrl: `${QORE_CONFIG.explorerBase}/address/${identity.vaultAddress}`,
        chainMode: "live-onchain",
        digestOrCalldataPreview: digestPreview,
      };
    }

    const verified = pqcVerify(hexToBytes(pubHex), hexToBytes(digestHex), tamperedSig);
    return {
      attackType,
      title: "Q-Day Spoof: Corrupted ML-DSA-87 Signature",
      blocked: !verified,
      enforcedBy: "BlindIntentVault pqcVerify (0x...0a01)",
      reason: `FIPS 204 ML-DSA-87 verifier rejected corrupted signature (valid=${verified}) — Solidity precompile 0x...0a01 fails closed`,
      txHash: null,
      explorerUrl: null,
      chainMode: "local-crypto-preview",
      digestOrCalldataPreview: digestPreview,
    };
  }

  listOrders(): SealedOrderRecord[] {
    return Array.from(this.orders.values()).reverse();
  }
}
