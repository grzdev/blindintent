import fs from "node:fs";
import path from "node:path";

export const QORE_CONFIG = {
  network: (process.env.QORE_NETWORK ?? "testnet") as "testnet" | "mainnet",
  chainId: process.env.QORE_CHAIN_ID ?? "qorechain-diana",
  evmChainId: 9800,
  restUrl: process.env.QORE_REST_URL ?? "https://api-testnet.qore.host",
  rpcUrl: process.env.QORE_RPC_URL ?? "https://rpc-testnet.qore.host",
  evmRpcUrl: process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host",
  explorerBase: "https://explore.qore.network",
  precompiles: {
    pqcVerify: "0x0000000000000000000000000000000000000a01" as `0x${string}`,
    pqcKeyStatus: "0x0000000000000000000000000000000000000a02" as `0x${string}`,
  },
  tokens: {
    fUSD: {
      symbol: "fUSD",
      name: "FestUSD",
      decimals: 6,
      erc20: (process.env.FUSD_ERC20 ?? "0x97143B771D34ddb9130b807b135Ae675A5a963CA") as `0x${string}`,
      bankDenom: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA",
      ruleDenom: "erc20/0x97143B771D34ddb9130b807b135Ae675A5a963CA",
    },
    fETH: {
      symbol: "fETH",
      name: "FestETH",
      decimals: 18,
      erc20: (process.env.FETH_ERC20 ?? "0x02292293c13880a26242690eb70a0e42B8E91c28") as `0x${string}`,
      bankDenom: "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28",
      ruleDenom: "erc20/0x02292293c13880a26242690eb70a0e42B8E91c28",
    },
    fBTC: {
      symbol: "fBTC",
      name: "FestBTC",
      decimals: 8,
      erc20: (process.env.FBTC_ERC20 ?? "0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A") as `0x${string}`,
      bankDenom: "erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A",
      ruleDenom: "erc20/0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A",
    },
  },
  ammPoolEthUsdId: "3",
} as const;

export type TokenSymbol = keyof typeof QORE_CONFIG.tokens;

export function getVaultAddress(): `0x${string}` | null {
  const addr = (process.env.VAULT_ADDRESS || process.env.VITE_VAULT_ADDRESS || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

export function loadVaultArtifact(): { abi: readonly Record<string, unknown>[]; bytecode: `0x${string}` } {
  const p = path.resolve(
    import.meta.dirname,
    "../../contracts/artifacts/contracts/BlindIntentVault.sol/BlindIntentVault.json",
  );
  if (!fs.existsSync(p)) {
    throw new Error(`Missing BlindIntentVault artifact at ${p}. Run \`npm run contracts:build\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
