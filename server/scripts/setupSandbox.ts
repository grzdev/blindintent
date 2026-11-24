import fs from "node:fs";
import path from "node:path";
import {
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchAuthenticators,
  fetchPqcStatus,
  generateMnemonic,
  linkAuthenticatorMsgs,
  signAuthenticatorLinkEip191,
  signProofOfPossession,
} from "@qorechain/sdk";
import { buildRegisterKemKeyMessage, deriveSealKeys } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QORE_CONFIG, getVaultAddress, loadVaultArtifact } from "../src/config.js";
import { broadcastHybridMessages, fetchAccountSequence, fetchAddressBalances } from "../src/qoreClient.js";

const ENV_PATH = path.resolve(import.meta.dirname, "../../.env");

const qoreTestnetChain = defineChain({
  id: QORE_CONFIG.evmChainId,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [QORE_CONFIG.evmRpcUrl] } },
});

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function keygen(): Promise<void> {
  if (fs.existsSync(ENV_PATH)) {
    console.log(`.env already exists at ${ENV_PATH}. Inspecting existing accounts...`);
  }

  const deployerMnemonic = process.env.DEPLOYER_MNEMONIC?.trim() || generateMnemonic(128);
  const ownerMnemonic = process.env.SANDBOX_OWNER_MNEMONIC?.trim() || generateMnemonic(128);
  const agentMnemonic = process.env.SANDBOX_AGENT_MNEMONIC?.trim() || generateMnemonic(128);
  const relayerMnemonic = process.env.SANDBOX_RELAYER_MNEMONIC?.trim() || generateMnemonic(128);

  const [dep, own, agt, rel] = await Promise.all([
    deriveUnifiedAccount(deployerMnemonic, 0),
    deriveUnifiedAccount(ownerMnemonic, 0),
    deriveUnifiedAccount(agentMnemonic, 0),
    deriveUnifiedAccount(relayerMnemonic, 0),
  ]);

  if (!fs.existsSync(ENV_PATH)) {
    const content = [
      `QORE_NETWORK=testnet`,
      `QORE_CHAIN_ID=qorechain-diana`,
      `QORE_REST_URL=https://api-testnet.qore.host`,
      `QORE_RPC_URL=https://rpc-testnet.qore.host`,
      `QORE_EVM_RPC_URL=https://evm-testnet.qore.host`,
      `DEPLOYER_PRIVATE_KEY=${toHex(dep.privateKey)}`,
      `DEPLOYER_MNEMONIC="${deployerMnemonic}"`,
      `SANDBOX_OWNER_MNEMONIC="${ownerMnemonic}"`,
      `SANDBOX_AGENT_MNEMONIC="${agentMnemonic}"`,
      `SANDBOX_RELAYER_MNEMONIC="${relayerMnemonic}"`,
      `VAULT_ADDRESS=`,
      `VITE_VAULT_ADDRESS=`,
      `PORT=8787`,
    ].join("\n");
    fs.writeFileSync(ENV_PATH, content + "\n", "utf8");
    console.log(`Generated fresh TESTNET-ONLY credentials in gitignored ${ENV_PATH}`);
  }

  console.log("\n--- TESTNET-ONLY SANDBOX ADDRESSES (qorechain-diana) ---");
  console.log(`DEPLOYER:      cosmos=${dep.cosmos}  evm=${dep.evm}`);
  console.log(`SANDBOX_OWNER: cosmos=${own.cosmos}  evm=${own.evm}`);
  console.log(`SANDBOX_AGENT: cosmos=${agt.cosmos}  evm=${agt.evm}  (linked authenticator key)`);
  console.log(`RELAYER:       cosmos=${rel.cosmos}  evm=${rel.evm}`);
  console.log("\nFund DEPLOYER, SANDBOX_OWNER, and RELAYER via faucet / QoreX testnet, then run:");
  console.log("  npx --workspace=server tsx --env-file=.env scripts/setupSandbox.ts init");
}

async function initOnChain(): Promise<void> {
  const ownerMn = process.env.SANDBOX_OWNER_MNEMONIC?.trim();
  const agentMn = process.env.SANDBOX_AGENT_MNEMONIC?.trim();
  const relayerMn = process.env.SANDBOX_RELAYER_MNEMONIC?.trim();
  const depMn = process.env.DEPLOYER_MNEMONIC?.trim();
  if (!ownerMn || !agentMn || !relayerMn || !depMn) {
    throw new Error("Run `keygen` first so DEPLOYER/OWNER/AGENT/RELAYER mnemonics exist in .env");
  }

  const [dep, owner, agent, relayer] = await Promise.all([
    deriveUnifiedAccount(depMn, 0),
    deriveUnifiedAccount(ownerMn, 0),
    deriveUnifiedAccount(agentMn, 0),
    deriveUnifiedAccount(relayerMn, 0),
  ]);

  const accounts = [
    { name: "DEPLOYER", acc: dep },
    { name: "SANDBOX_OWNER", acc: owner },
    { name: "SANDBOX_RELAYER", acc: relayer },
  ];

  // 1. Check funding & register ML-DSA-87 PQC keys
  for (const { name, acc } of accounts) {
    const seq = await fetchAccountSequence(acc.cosmos);
    const bals = await fetchAddressBalances(acc.cosmos);
    console.log(`${name} (${acc.cosmos}) balances:`, bals.map((b) => `${b.amount} ${b.denom}`).join(", ") || "EMPTY");
    if (!seq.exists) {
      throw new Error(`${name} needs test QOR before registering PQC keys.`);
    }
    const pqc = await fetchPqcStatus({ rest: QORE_CONFIG.restUrl, address: acc.cosmos });
    if (!pqc.registered) {
      const pop = signProofOfPossession({ chainId: QORE_CONFIG.chainId, account: acc.cosmos, keypair: acc.pqc });
      const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop });
      const res = await broadcastHybridMessages(acc, [msg], { mode: "classical" });
      console.log(`${name} PQC key registered: ${res.transactionHash}`);
    } else {
      console.log(`${name} PQC key already registered (possessionProven=${pqc.possessionProven})`);
    }
  }

  // 2. Register Owner + Agent ML-KEM-1024 QoreSeal keys on-chain
  for (const { name, acc, mn } of [
    { name: "SANDBOX_OWNER", acc: owner, mn: ownerMn },
    { name: "SANDBOX_AGENT", acc: agent, mn: agentMn },
  ]) {
    const seq = await fetchAccountSequence(acc.cosmos);
    if (!seq.exists) continue;
    const pqc = await fetchPqcStatus({ rest: QORE_CONFIG.restUrl, address: acc.cosmos });
    if (!pqc.registered && name === "SANDBOX_AGENT") {
      const pop = signProofOfPossession({ chainId: QORE_CONFIG.chainId, account: acc.cosmos, keypair: acc.pqc });
      const regMsg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop });
      await broadcastHybridMessages(acc, [regMsg], { mode: "classical" });
    }
    const kem = await fetchKemKey({ rest: QORE_CONFIG.restUrl, address: acc.cosmos });
    if (!kem.registered) {
      const sealKeys = deriveSealKeys({ mnemonic: mn });
      const kemMsg = buildRegisterKemKeyMessage({
        sender: acc.cosmos,
        mlkemPublicKey: sealKeys.mlkemPublicKey,
      });
      const res = await broadcastHybridMessages(acc, [kemMsg]);
      console.log(`${name} QoreSeal ML-KEM-1024 key registered: ${res.transactionHash}`);
    }
  }

  // 3. Link Agent authenticator key to Owner with strict SpendingRule
  const vaultAddress = getVaultAddress();
  if (!vaultAddress) {
    console.log("Notice: VAULT_ADDRESS not set yet. Deploy BlindIntentVault first, then re-run `init` to lock allowedEvmCalls.");
    return;
  }

  const existingAuths = await fetchAuthenticators({ rest: QORE_CONFIG.restUrl, address: owner.cosmos });
  const agentHex = agent.evm.toLowerCase().replace(/^0x/, "");
  const alreadyLinked = existingAuths.some((a) => a.pubkeyHex.toLowerCase() === agentHex && !a.revoked);

  if (!alreadyLinked) {
    const proof = signAuthenticatorLinkEip191({
      chainId: QORE_CONFIG.chainId,
      account: owner.cosmos,
      privateKey: toHex(agent.privateKey),
    });
    const linkMsgs = linkAuthenticatorMsgs({
      owner: owner.cosmos,
      chainId: QORE_CONFIG.chainId,
      scheme: proof.scheme,
      pubkey: proof.pubkey,
      possessionProof: proof.possessionProof,
      permissions: ["evm"],
      expiryUnix: Math.floor(Date.now() / 1000) + 14 * 24 * 3600,
      label: "blindintent-agent-v1",
      spendingRules: [
        {
          id: "blindintent-vault-caps",
          enabled: true,
          perTxLimit: "1000000", // 1 QOR max native tx spend
          dailyLimit: "10000000", // 10 QOR max UTC daily spend
          allowedDenoms: [
            "uqor",
            QORE_CONFIG.tokens.fUSD.ruleDenom,
            QORE_CONFIG.tokens.fETH.ruleDenom,
            QORE_CONFIG.tokens.fBTC.ruleDenom,
          ],
          allowedEvmCalls: [vaultAddress],
          denomLimits: [
            { denom: QORE_CONFIG.tokens.fUSD.ruleDenom, perTxLimit: "500000000", dailyLimit: "2000000000" },
            { denom: QORE_CONFIG.tokens.fETH.ruleDenom, perTxLimit: "500000000000000000", dailyLimit: "1500000000000000000" },
          ],
        },
      ],
    });
    const linkRes = await broadcastHybridMessages(owner, linkMsgs);
    console.log(`Linked SANDBOX_AGENT under strict SpendingRule: ${linkRes.transactionHash}`);
  } else {
    console.log("SANDBOX_AGENT already linked to SANDBOX_OWNER.");
  }

  // 4. Seed owner token allowance for BlindIntentVault if EVM window is open
  const publicClient = createPublicClient({ chain: qoreTestnetChain, transport: http(QORE_CONFIG.evmRpcUrl) });
  const ownerWallet = createWalletClient({
    account: privateKeyToAccount(toHex(owner.privateKey)),
    chain: qoreTestnetChain,
    transport: http(QORE_CONFIG.evmRpcUrl),
  });
  const { abi } = loadVaultArtifact();
  const resEth = (await publicClient.readContract({
    address: vaultAddress,
    abi,
    functionName: "poolReserves",
    args: [QORE_CONFIG.tokens.fETH.erc20],
  })) as bigint;
  console.log(`BlindIntentVault fETH reserve: ${resEth.toString()}`);

  const ownerEthBal = await publicClient.readContract({
    address: QORE_CONFIG.tokens.fETH.erc20,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner.evm as `0x${string}`],
  });
  console.log(`SANDBOX_OWNER ERC-20 fETH balance: ${ownerEthBal.toString()}`, ownerWallet.account.address);
  void parseUnits;
}

const cmd = process.argv[2] ?? "keygen";
(cmd === "init" ? initOnChain() : keygen()).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
