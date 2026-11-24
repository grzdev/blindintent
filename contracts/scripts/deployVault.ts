import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const EVM_RPC = process.env.QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
const qoreTestnetChain = defineChain({
  id: 9800,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
  blockExplorers: { default: { name: "QoreChain Explorer", url: "https://explore.qore.network" } },
});

const ARTIFACT_PATH = path.resolve(
  import.meta.dirname,
  "../artifacts/contracts/BlindIntentVault.sol/BlindIntentVault.json",
);

async function main(): Promise<void> {
  const pk = (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      "Missing valid DEPLOYER_PRIVATE_KEY in .env (run `npm run sandbox:keygen` first and open an EVM window).",
    );
  }

  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error("Compiled artifact not found. Run `npm run contracts:build` first.");
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")) as {
    abi: unknown[];
    bytecode: `0x${string}`;
  };

  const account = privateKeyToAccount(pk as `0x${string}`);
  const publicClient = createPublicClient({ chain: qoreTestnetChain, transport: http(EVM_RPC) });
  const walletClient = createWalletClient({ account, chain: qoreTestnetChain, transport: http(EVM_RPC) });

  console.log(`Deploying BlindIntentVault from ${account.address} to ${EVM_RPC}...`);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    chain: qoreTestnetChain,
    args: [],
  });

  console.log(`Deployment tx submitted: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("Deployment receipt missing contractAddress");
  }

  const runtimeCode = (await publicClient.getCode({ address: receipt.contractAddress })) ?? "0x";
  const has0a01 = runtimeCode.toLowerCase().includes("0000000000000000000000000000000000000a01");
  const has0a02 = runtimeCode.toLowerCase().includes("0000000000000000000000000000000000000a02");

  console.log(`BlindIntentVault deployed: ${receipt.contractAddress}`);
  console.log(`Explorer tx:  https://explore.qore.network/tx/${hash}`);
  console.log(`Precompile 0x...0a01 embedded: ${has0a01}`);
  console.log(`Precompile 0x...0a02 embedded: ${has0a02}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
