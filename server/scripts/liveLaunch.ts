import fs from "node:fs";
import path from "node:path";
import {
  amm,
  bank,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchAuthenticators,
  fetchPqcStatus,
  isRegisteredPqcKey,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  signAuthenticatorLinkEip191,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { buildRegisterKemKeyMessage, deriveSealKeys } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  maxUint256,
  parseUnits,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BlindIntentEngine } from "../src/blindIntentEngine.js";
import { QORE_CONFIG, getVaultAddress, loadVaultArtifact } from "../src/config.js";
import { broadcastHybridMessages, fetchAccountSequence, fetchAddressBalances } from "../src/qoreClient.js";

const ENV_PATH = path.resolve(import.meta.dirname, "../../.env");

const qoreTestnetChain = defineChain({
  id: QORE_CONFIG.evmChainId,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [QORE_CONFIG.evmRpcUrl] } },
  blockExplorers: { default: { name: "QoreChain Explorer", url: QORE_CONFIG.explorerBase } },
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
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function upsertEnvValue(key: string, value: string): void {
  process.env[key] = value;
  if (!fs.existsSync(ENV_PATH)) return;
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  let updated = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!updated) nextLines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, nextLines.join("\n").replace(/\n+$/, "") + "\n", "utf8");
}

async function getUqorBalance(address: string): Promise<bigint> {
  const bals = await fetchAddressBalances(address);
  const uqor = bals.find((b) => b.denom === "uqor");
  return BigInt(uqor?.amount ?? "0");
}

async function ensurePqcRegistered(name: string, acc: UnifiedAccount): Promise<{ txHash: string | null }> {
  const pqc = await fetchPqcStatus({ rest: QORE_CONFIG.restUrl, address: acc.cosmos });
  if (pqc.registered && isRegisteredPqcKey(pqc, acc.pqc.publicKey)) {
    console.log(`[PQC] ${name} already registered (possessionProven=${pqc.possessionProven})`);
    return { txHash: null };
  }
  const pop = signProofOfPossession({ chainId: QORE_CONFIG.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop });
  const res = await broadcastHybridMessages(acc, [msg], { mode: "classical" });
  console.log(`[PQC] ${name} ML-DSA-87 registered: ${res.transactionHash}`);
  return { txHash: res.transactionHash };
}

async function ensureKemRegistered(name: string, acc: UnifiedAccount, mnemonic: string): Promise<string | null> {
  const kem = await fetchKemKey({ rest: QORE_CONFIG.restUrl, address: acc.cosmos });
  if (kem.registered) {
    console.log(`[KEM] ${name} ML-KEM-1024 QoreSeal key already on-chain.`);
    return null;
  }
  const sealKeys = deriveSealKeys({ mnemonic });
  const msg = buildRegisterKemKeyMessage({
    sender: acc.cosmos,
    mlkemPublicKey: sealKeys.mlkemPublicKey,
  });
  const res = await broadcastHybridMessages(acc, [msg], { mode: "hybrid" });
  console.log(`[KEM] ${name} ML-KEM-1024 registered: ${res.transactionHash}`);
  return res.transactionHash;
}

async function ensureEvmWindowOpen(name: string, acc: UnifiedAccount, minTxs = 4n): Promise<void> {
  const win = await evmWindowStatus({ rest: QORE_CONFIG.restUrl, address: acc.cosmos });
  if (win.found && win.live && BigInt(win.remainingTxs) >= minTxs && BigInt(win.remainingBlocks) >= 30n) {
    console.log(`[WIN] ${name} EVM window open (${win.remainingTxs} txs, ${win.remainingBlocks} blocks left).`);
    return;
  }
  const blocks = 1200n;
  const maxTxs = 8n;
  const perTx = evmWindowCost({ gas: 4_000_000n, maxFeePerGas: 250_000_000_000n });
  const maxValue = perTx * maxTxs;
  const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks, maxTxs, maxValue });
  const res = await broadcastHybridMessages(acc, [msg], { mode: "hybrid" });
  console.log(`[WIN] ${name} EVM window opened: ${res.transactionHash}`);
}

async function main(): Promise<void> {
  const depMn = process.env.DEPLOYER_MNEMONIC?.trim();
  const ownerMn = process.env.SANDBOX_OWNER_MNEMONIC?.trim();
  const agentMn = process.env.SANDBOX_AGENT_MNEMONIC?.trim();
  const relayerMn = process.env.SANDBOX_RELAYER_MNEMONIC?.trim();
  if (!depMn || !ownerMn || !agentMn || !relayerMn) {
    throw new Error("Missing sandbox mnemonics in .env. Run `npm --workspace=server run tsx -- scripts/setupSandbox.ts keygen` first.");
  }

  const [dep, owner, agent, relayer] = await Promise.all([
    deriveUnifiedAccount(depMn, 0),
    deriveUnifiedAccount(ownerMn, 0),
    deriveUnifiedAccount(agentMn, 0),
    deriveUnifiedAccount(relayerMn, 0),
  ]);

  // 1. Verify DEPLOYER funding and distribute test QOR cleanly to sub-accounts
  const depSeq = await fetchAccountSequence(dep.cosmos);
  const depBal = await getUqorBalance(dep.cosmos);
  console.log(`DEPLOYER (${dep.cosmos}) balance: ${formatUnits(depBal, 6)} QOR`);
  if (!depSeq.exists || depBal < 10_000_000n) {
    throw new Error(
      `DEPLOYER ${dep.cosmos} needs test QOR first (>= 25 QOR recommended) before liveLaunch can run.`,
    );
  }

  // Register DEPLOYER PQC early so subsequent distributions and actions carry hybrid PQ+secp256k1 proofs
  await ensurePqcRegistered("DEPLOYER", dep);

  const allocations: Array<{ label: string; acc: UnifiedAccount; targetUqor: bigint }> = [
    { label: "SANDBOX_OWNER", acc: owner, targetUqor: 12_000_000n },
    { label: "SANDBOX_AGENT", acc: agent, targetUqor: 3_000_000n },
    { label: "RELAYER", acc: relayer, targetUqor: 10_000_000n },
  ];

  for (const item of allocations) {
    const cur = await getUqorBalance(item.acc.cosmos);
    if (cur < item.targetUqor / 2n) {
      const sendAmt = item.targetUqor - cur;
      const sendMsg = bank.send({
        fromAddress: dep.cosmos,
        toAddress: item.acc.cosmos,
        amount: [{ denom: "uqor", amount: sendAmt.toString() }],
      });
      const sendRes = await broadcastHybridMessages(dep, [sendMsg], { mode: "hybrid" });
      console.log(`[FUND] Sent ${formatUnits(sendAmt, 6)} QOR -> ${item.label} (${item.acc.cosmos}): ${sendRes.transactionHash}`);
    } else {
      console.log(`[FUND] ${item.label} already funded (${formatUnits(cur, 6)} QOR).`);
    }
  }

  // 2. Register ML-DSA-87 + ML-KEM-1024 on-chain for SANDBOX_OWNER, SANDBOX_AGENT, and RELAYER
  await ensurePqcRegistered("SANDBOX_OWNER", owner);
  await ensurePqcRegistered("SANDBOX_AGENT", agent);
  await ensurePqcRegistered("RELAYER", relayer);
  const ownerKemTx = await ensureKemRegistered("SANDBOX_OWNER", owner, ownerMn);
  const agentKemTx = await ensureKemRegistered("SANDBOX_AGENT", agent, agentMn);

  // 3. Execute live AMM Pool #2 swap (uqor -> fUSD) to verify native x/amm integration & Ship Week badge
  const swapMsg = amm.swapExactIn({
    sender: dep.cosmos,
    poolId: "2",
    tokenIn: { denom: "uqor", amount: "2000000" }, // 2 QOR
    denomOut: QORE_CONFIG.tokens.fUSD.bankDenom,
    minOut: "1",
  });
  const ammSwapRes = await broadcastHybridMessages(dep, [swapMsg], { mode: "hybrid" });
  console.log(`[AMM] Swap 2 QOR -> fUSD on Pool #2 tx: ${ammSwapRes.transactionHash}`);

  // 4. Deploy BlindIntentVault on QoreChain EVM (9800) if not already deployed
  const publicClient = createPublicClient({ chain: qoreTestnetChain, transport: http(QORE_CONFIG.evmRpcUrl) });
  let vaultAddress = getVaultAddress();
  let deployTxHash: string | null = null;

  if (vaultAddress) {
    const code = (await publicClient.getCode({ address: vaultAddress })) ?? "0x";
    if (code === "0x") vaultAddress = null;
  }

  if (!vaultAddress) {
    await ensureEvmWindowOpen("DEPLOYER", dep, 4n);
    const { abi, bytecode } = loadVaultArtifact();
    const depWallet = createWalletClient({
      account: privateKeyToAccount(toHex(dep.privateKey)),
      chain: qoreTestnetChain,
      transport: http(QORE_CONFIG.evmRpcUrl),
    });
    const hash = await depWallet.deployContract({
      abi,
      bytecode,
      chain: qoreTestnetChain,
      args: [],
    });
    deployTxHash = hash;
    console.log(`[DEPLOY] Submitted BlindIntentVault deploy tx: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Deployment receipt missing contractAddress");
    vaultAddress = receipt.contractAddress;

    const runtimeCode = ((await publicClient.getCode({ address: vaultAddress })) ?? "0x").toLowerCase();
    const has0a01 = runtimeCode.includes("610a01") || runtimeCode.includes("0000000000000000000000000000000000000a01");
    const has0a02 = runtimeCode.includes("610a02") || runtimeCode.includes("0000000000000000000000000000000000000a02");
    console.log(`[DEPLOY] BlindIntentVault deployed at ${vaultAddress} (0x0a01=${has0a01}, 0x0a02=${has0a02})`);

    upsertEnvValue("VAULT_ADDRESS", vaultAddress);
    upsertEnvValue("VITE_VAULT_ADDRESS", vaultAddress);
  } else {
    console.log(`[DEPLOY] Reusing existing BlindIntentVault at ${vaultAddress}`);
  }

  // 5. Link SANDBOX_AGENT authenticator key to SANDBOX_OWNER with SpendingRule pinned to vaultAddress
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
          perTxLimit: "1000000",
          dailyLimit: "10000000",
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
    const linkRes = await broadcastHybridMessages(owner, linkMsgs, { mode: "hybrid" });
    console.log(`[AA] Linked SANDBOX_AGENT authenticator -> SANDBOX_OWNER tx: ${linkRes.transactionHash}`);
  } else {
    console.log("[AA] SANDBOX_AGENT already linked to SANDBOX_OWNER.");
  }

  // 6. Inspect EVM ERC-20 balances and seed BlindIntentVault reserves / owner approvals when funded
  const depFusd = await publicClient.readContract({
    address: QORE_CONFIG.tokens.fUSD.erc20,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [dep.evm as `0x${string}`],
  });
  const depFeth = await publicClient.readContract({
    address: QORE_CONFIG.tokens.fETH.erc20,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [dep.evm as `0x${string}`],
  });
  const ownerFeth = await publicClient.readContract({
    address: QORE_CONFIG.tokens.fETH.erc20,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner.evm as `0x${string}`],
  });
  const ownerFusd = await publicClient.readContract({
    address: QORE_CONFIG.tokens.fUSD.erc20,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner.evm as `0x${string}`],
  });

  console.log(`[ERC20] DEPLOYER fUSD=${formatUnits(depFusd, 6)}, fETH=${formatUnits(depFeth, 18)}`);
  console.log(`[ERC20] OWNER    fUSD=${formatUnits(ownerFusd, 6)}, fETH=${formatUnits(ownerFeth, 18)}`);

  if (ownerFeth === 0n && depFeth >= parseUnits("0.01", 18)) {
    await ensureEvmWindowOpen("DEPLOYER", dep, 4n);
    const depWallet = createWalletClient({
      account: privateKeyToAccount(toHex(dep.privateKey)),
      chain: qoreTestnetChain,
      transport: http(QORE_CONFIG.evmRpcUrl),
    });
    const tx = await depWallet.writeContract({
      address: QORE_CONFIG.tokens.fETH.erc20,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [owner.evm as `0x${string}`, parseUnits("0.005", 18)],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`[ERC20] Funded SANDBOX_OWNER with 0.005 fETH: ${tx}`);
  }

  // Approve BlindIntentVault from SANDBOX_OWNER for fETH & fUSD
  const ownerAllowanceEth = await publicClient.readContract({
    address: QORE_CONFIG.tokens.fETH.erc20,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner.evm as `0x${string}`, vaultAddress],
  });
  if (ownerAllowanceEth === 0n) {
    await ensureEvmWindowOpen("SANDBOX_OWNER", owner, 3n);
    const ownerWallet = createWalletClient({
      account: privateKeyToAccount(toHex(owner.privateKey)),
      chain: qoreTestnetChain,
      transport: http(QORE_CONFIG.evmRpcUrl),
    });
    const appEth = await ownerWallet.writeContract({
      address: QORE_CONFIG.tokens.fETH.erc20,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, maxUint256],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: appEth });
    const appUsd = await ownerWallet.writeContract({
      address: QORE_CONFIG.tokens.fUSD.erc20,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, maxUint256],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: appUsd });
    console.log(`[ERC20] SANDBOX_OWNER approved BlindIntentVault for fETH (${appEth}) & fUSD (${appUsd})`);
  }

  // Seed BlindIntentVault reserves from DEPLOYER if empty and DEPLOYER holds fUSD/fETH
  const { abi } = loadVaultArtifact();
  const vaultUsd = (await publicClient.readContract({
    address: vaultAddress,
    abi,
    functionName: "poolReserves",
    args: [QORE_CONFIG.tokens.fUSD.erc20],
  })) as bigint;
  const vaultEth = (await publicClient.readContract({
    address: vaultAddress,
    abi,
    functionName: "poolReserves",
    args: [QORE_CONFIG.tokens.fETH.erc20],
  })) as bigint;

  if (vaultUsd === 0n && depFusd > 0n) {
    await ensureEvmWindowOpen("DEPLOYER", dep, 4n);
    const depWallet = createWalletClient({
      account: privateKeyToAccount(toHex(dep.privateKey)),
      chain: qoreTestnetChain,
      transport: http(QORE_CONFIG.evmRpcUrl),
    });
    const seedUsd = depFusd > parseUnits("10", 6) ? depFusd / 2n : depFusd;
    const appTx = await depWallet.writeContract({
      address: QORE_CONFIG.tokens.fUSD.erc20,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, maxUint256],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });
    const addUsdTx = await depWallet.writeContract({
      address: vaultAddress,
      abi,
      functionName: "addLiquidity",
      args: [QORE_CONFIG.tokens.fUSD.erc20, seedUsd],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: addUsdTx });
    console.log(`[VAULT] Seeded ${formatUnits(seedUsd, 6)} fUSD reserve: ${addUsdTx}`);
  }
  if (vaultEth === 0n && depFeth >= parseUnits("0.002", 18)) {
    await ensureEvmWindowOpen("DEPLOYER", dep, 3n);
    const depWallet = createWalletClient({
      account: privateKeyToAccount(toHex(dep.privateKey)),
      chain: qoreTestnetChain,
      transport: http(QORE_CONFIG.evmRpcUrl),
    });
    const seedEth = depFeth / 2n;
    const appTx = await depWallet.writeContract({
      address: QORE_CONFIG.tokens.fETH.erc20,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [vaultAddress, maxUint256],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: appTx });
    const addEthTx = await depWallet.writeContract({
      address: vaultAddress,
      abi,
      functionName: "addLiquidity",
      args: [QORE_CONFIG.tokens.fETH.erc20, seedEth],
      chain: qoreTestnetChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: addEthTx });
    console.log(`[VAULT] Seeded ${formatUnits(seedEth, 18)} fETH reserve: ${addEthTx}`);
  }

  // 7. Run live engine smoke pass (Seal -> Check PQC -> Attack Lab)
  const engine = new BlindIntentEngine();
  const status = await engine.getIdentityStatus();
  console.log(`[ENGINE] mode=${status.mode}, pqcReady=${status.pqcReady}, kemReady=${status.kemReady}, agentLinked=${status.agentLinked}`);

  if (status.mode === "live-onchain") {
    const sealed = await engine.sealIntent("Protect 0.001 fETH: sell to fUSD if fETH drops below 5000 USD, max 1% slippage, 24h");
    console.log(`[LIVE SEAL] onChainIntentId=${sealed.onChainIntentId}, registerTx=${sealed.registerTxHash}`);

    const atkTarget = await engine.simulateAttack("unauthorized-target", sealed.id);
    console.log(`[LIVE ATTACK:target] blocked=${atkTarget.blocked}, reason=${atkTarget.reason}`);

    const atkTamper = await engine.simulateAttack("pqc-signature-tamper", sealed.id);
    console.log(`[LIVE ATTACK:pqc] blocked=${atkTamper.blocked}, reason=${atkTamper.reason}`);

    const finalEthReserve = (await publicClient.readContract({
      address: vaultAddress,
      abi,
      functionName: "poolReserves",
      args: [QORE_CONFIG.tokens.fETH.erc20],
    })) as bigint;
    const finalUsdReserve = (await publicClient.readContract({
      address: vaultAddress,
      abi,
      functionName: "poolReserves",
      args: [QORE_CONFIG.tokens.fUSD.erc20],
    })) as bigint;
    if (finalEthReserve > 0n && finalUsdReserve > 0n && ownerFeth > 0n) {
      const settle = await engine.evaluateAndExecute(sealed.id, 4900);
      console.log(`[LIVE SETTLE] triggered=${settle.triggered}, tx=${settle.order.settleTxHash}, out=${settle.order.amountOutDisplay}`);
    } else {
      console.log("[LIVE SETTLE] Skipped settlement tx: claim fest fETH/fUSD on dashboard faucet to fund vault swap reserves.");
    }
  }

  console.log("\n=== LIVE LAUNCH SUMMARY ===");
  console.log(`DEPLOYER:        ${dep.cosmos} / ${dep.evm}`);
  console.log(`SANDBOX_OWNER:   ${owner.cosmos} / ${owner.evm}`);
  console.log(`VAULT_ADDRESS:   ${vaultAddress}`);
  console.log(`DEPLOY_TX:       ${deployTxHash ?? "(previously deployed)"}`);
  console.log(`AMM_SWAP_TX:     ${ammSwapRes.transactionHash}`);
  console.log(`OWNER_KEM_TX:    ${ownerKemTx ?? "(previously registered)"}`);
  console.log(`AGENT_KEM_TX:    ${agentKemTx ?? "(previously registered)"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
