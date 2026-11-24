export type TokenSymbol = "fUSD" | "fETH" | "fBTC";

export interface ChainTelemetry {
  chainId: string;
  evmChainId: number;
  latestHeight: number | null;
  activePrecompiles: string[];
  pqcVerifyActive: boolean;
  pqcKeyStatusActive: boolean;
  abstractAccountEnabled: boolean;
  ammPool3: {
    id: string;
    reserveA: string;
    reserveB: string;
    weightedAvgPrice: string;
    status: string;
  } | null;
  liveEthUsdReference: number;
  rpcReachable: boolean;
}

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

export interface HealthPayload {
  ok: boolean;
  telemetry: ChainTelemetry;
  identity: SandboxIdentity;
  ordersCount: number;
}

export interface CompiledIntentSpec {
  title: string;
  rawPrompt: string;
  action: "sell" | "buy";
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountInDisplay: string;
  triggerDirection: "below" | "above";
  triggerPriceUsd: number;
  maxSlippageBps: number;
  durationHours: number;
  capPerTxDisplay: string;
  capDailyDisplay: string;
  parserMode: "llm" | "deterministic";
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

export interface DecryptedOrderPayload {
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
