import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  decodeEventLog,
  encodePacked,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
} from "viem";

describe("BlindIntentVault", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, agent, attacker] = await viem.getWalletClients();

  const FAKE_PQ_PUBKEY = toHex(new Uint8Array(2592).fill(0x11));
  const OTHER_PQ_PUBKEY = toHex(new Uint8Array(2592).fill(0x22));
  const FAKE_PQ_SIG = toHex(new Uint8Array(4627).fill(0xaa));
  const FAKE_KEM_ENVELOPE = stringToHex("QSEL:mlkem1024-ciphertext-hidden-trigger-3100");
  const FAKE_RECEIPT = stringToHex("QSEL:encrypted-receipt-01");
  const SALT = keccak256(stringToHex("intent-salt-1"));

  async function deployFixture() {
    const mockPqc = await viem.deployContract("MockQorePQC");
    const vault = await viem.deployContract("TestableBlindIntentVault", [mockPqc.address]);
    const prodVault = await viem.deployContract("BlindIntentVault");

    const fEth = await viem.deployContract("MockERC20", ["FestETH", "fETH", 18]);
    const fUsd = await viem.deployContract("MockERC20", ["FestUSD", "fUSD", 6]);

    // Seed liquidity: 10 fETH <-> 32,000 fUSD (implied 3,200 fUSD / fETH)
    await fEth.write.mint([owner.account.address, parseUnits("20", 18)]);
    await fUsd.write.mint([owner.account.address, parseUnits("40000", 6)]);
    await fEth.write.approve([vault.address, parseUnits("100", 18)]);
    await fUsd.write.approve([vault.address, parseUnits("100000", 6)]);

    await vault.write.addLiquidity([fEth.address, parseUnits("10", 18)]);
    await vault.write.addLiquidity([fUsd.address, parseUnits("32000", 6)]);

    await mockPqc.write.setKeyStatus([
      owner.account.address,
      true,
      1,
      FAKE_PQ_PUBKEY,
      true,
    ]);

    return { mockPqc, vault, prodVault, fEth, fUsd };
  }

  it("embeds lowercase QoreChain PQC precompile addresses in runtime bytecode", async () => {
    const { prodVault } = await deployFixture();
    const bytecode = await publicClient.getCode({ address: prodVault.address });
    assert.ok(bytecode, "Runtime bytecode must exist");
    const lower = bytecode.toLowerCase();
    assert.ok(
      lower.includes("610a01") || lower.includes("0000000000000000000000000000000000000a01"),
      "Missing pqcVerify 0x...0a01 precompile reference",
    );
    assert.ok(
      lower.includes("610a02") || lower.includes("0000000000000000000000000000000000000a02"),
      "Missing pqcKeyStatus 0x...0a02 precompile reference",
    );
  });

  it("registers a sealed intent, verifies ML-DSA-87 precompiles, settles atomically, and blocks replay", async () => {
    const { mockPqc, vault, fEth, fUsd } = await deployFixture();
    const block = await publicClient.getBlock();
    const deadline = BigInt(block.timestamp) + 3600n;
    const maxAmountIn = parseUnits("0.5", 18);
    const minAmountOut = parseUnits("1500", 6);

    const digest = (await vault.read.computeCommitmentDigest([
      owner.account.address,
      SALT,
      fEth.address,
      fUsd.address,
      maxAmountIn,
      minAmountOut,
      deadline,
    ])) as `0x${string}`;

    await mockPqc.write.setSignatureValid([
      FAKE_PQ_PUBKEY,
      FAKE_PQ_SIG,
      encodePacked(["bytes32"], [digest]),
      true,
    ]);

    const regHash = await vault.write.registerSealedIntent([
      agent.account.address,
      fEth.address,
      fUsd.address,
      maxAmountIn,
      deadline,
      digest,
      FAKE_KEM_ENVELOPE,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: regHash });

    const beforeUsd = (await fUsd.read.balanceOf([owner.account.address])) as bigint;
    const execHash = await vault.write.executeSealedIntent(
      [1n, maxAmountIn, minAmountOut, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
      { account: agent.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: execHash });
    const afterUsd = (await fUsd.read.balanceOf([owner.account.address])) as bigint;

    assert.ok(afterUsd - beforeUsd >= minAmountOut, "Owner must receive at least minAmountOut");

    const settledLog = receipt.logs
      .map((l) => {
        try {
          return decodeEventLog({ abi: vault.abi, data: l.data, topics: l.topics });
        } catch {
          return null;
        }
      })
      .find((ev) => ev?.eventName === "SealedIntentSettled");
    assert.ok(settledLog, "Expected SealedIntentSettled event");

    // Replay must revert
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, minAmountOut, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: agent.account },
      ),
      /IntentNotArmed/,
    );
  });

  it("blocks unauthorized caller, unproven possession, and rogue PQ pubkey spoofing", async () => {
    const { mockPqc, vault, fEth, fUsd } = await deployFixture();
    const block = await publicClient.getBlock();
    const deadline = BigInt(block.timestamp) + 3600n;
    const maxAmountIn = parseUnits("0.25", 18);
    const minAmountOut = parseUnits("700", 6);

    const digest = (await vault.read.computeCommitmentDigest([
      owner.account.address,
      SALT,
      fEth.address,
      fUsd.address,
      maxAmountIn,
      minAmountOut,
      deadline,
    ])) as `0x${string}`;

    await vault.write.registerSealedIntent([
      agent.account.address,
      fEth.address,
      fUsd.address,
      maxAmountIn,
      deadline,
      digest,
      FAKE_KEM_ENVELOPE,
    ]);

    // 1. Unauthorized caller
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, minAmountOut, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: attacker.account },
      ),
      /UnauthorizedCaller/,
    );

    // 2. Spoofed PQ pubkey (even if attacker registers their own valid sig for that spoofed key)
    await mockPqc.write.setSignatureValid([
      OTHER_PQ_PUBKEY,
      FAKE_PQ_SIG,
      encodePacked(["bytes32"], [digest]),
      true,
    ]);
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, minAmountOut, SALT, OTHER_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: agent.account },
      ),
      /PqcPubkeyMismatch/,
    );

    // 3. Invalid ML-DSA-87 signature (forged classical / bad bytes)
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, minAmountOut, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: agent.account },
      ),
      /InvalidMlDsaSignature/,
    );

    // 4. Possession unproven on chain
    await mockPqc.write.setKeyStatus([
      owner.account.address,
      true,
      1,
      FAKE_PQ_PUBKEY,
      false,
    ]);
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, minAmountOut, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: agent.account },
      ),
      /PqcPossessionUnproven/,
    );
  });

  it("blocks slippage tampering and expired deadlines, and supports owner cancel", async () => {
    const { mockPqc, vault, fEth, fUsd } = await deployFixture();
    const block = await publicClient.getBlock();
    const deadline = BigInt(block.timestamp) + 3600n;
    const maxAmountIn = parseUnits("0.25", 18);
    const minAmountOut = parseUnits("700", 6);

    const digest = (await vault.read.computeCommitmentDigest([
      owner.account.address,
      SALT,
      fEth.address,
      fUsd.address,
      maxAmountIn,
      minAmountOut,
      deadline,
    ])) as `0x${string}`;

    await mockPqc.write.setSignatureValid([
      FAKE_PQ_PUBKEY,
      FAKE_PQ_SIG,
      encodePacked(["bytes32"], [digest]),
      true,
    ]);

    await vault.write.registerSealedIntent([
      agent.account.address,
      fEth.address,
      fUsd.address,
      maxAmountIn,
      deadline,
      digest,
      FAKE_KEM_ENVELOPE,
    ]);

    // Attacker tries weakening minAmountOut -> digest changes -> CommitmentMismatch
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, 1n, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: agent.account },
      ),
      /CommitmentMismatch/,
    );

    // Owner cancels intent cleanly
    await vault.write.cancelSealedIntent([1n], { account: owner.account });
    await assert.rejects(
      vault.write.executeSealedIntent(
        [1n, maxAmountIn, minAmountOut, SALT, FAKE_PQ_PUBKEY, FAKE_PQ_SIG, FAKE_RECEIPT],
        { account: agent.account },
      ),
      /IntentNotArmed/,
    );
  });
});
