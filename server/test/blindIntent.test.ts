import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveSealKeys,
  envelopeFromText,
  envelopeToText,
  open,
  recipientOf,
  seal,
} from "@qorechain/qoreseal";
import {
  deriveUnifiedAccount,
  evmAuthSignBytesV2,
  generateMnemonic,
  pqcSign,
  pqcVerify,
} from "@qorechain/sdk";
import { hexToBytes, keccak256, stringToHex } from "viem";
import { compileIntentPrompt, parseIntentDeterministic } from "../src/intentCompiler.js";

describe("BlindIntent Crypto & Compiler Suite", async () => {
  it("seals and opens intent payloads with ML-KEM-1024 domain separation", () => {
    const aliceKeys = deriveSealKeys({ mnemonic: generateMnemonic(128) });
    const bobKeys = deriveSealKeys({ mnemonic: generateMnemonic(128) });

    const payload = JSON.stringify({
      tokenIn: "fETH",
      tokenOut: "fUSD",
      triggerPriceUsd: 3040,
      maxSlippageBps: 50,
    });

    const envelope = seal({
      chainId: "qorechain-diana",
      purpose: "blindintent:order:v1",
      recipients: [recipientOf(bobKeys)],
      plaintext: new TextEncoder().encode(payload),
    });

    const asText = envelopeToText(envelope);
    assert.ok(asText.startsWith("qoreseal:"), "Must serialize with qoreseal: prefix");

    const decoded = open({
      chainId: "qorechain-diana",
      purpose: "blindintent:order:v1",
      envelope: envelopeFromText(asText),
      keys: bobKeys,
    });
    assert.equal(new TextDecoder().decode(decoded), payload);

    // Wrong recipient must fail closed
    assert.throws(() =>
      open({
        chainId: "qorechain-diana",
        purpose: "blindintent:order:v1",
        envelope,
        keys: aliceKeys,
      }),
    );

    // Wrong purpose domain separation must fail closed
    assert.throws(() =>
      open({
        chainId: "qorechain-diana",
        purpose: "blindintent:receipt:v1",
        envelope,
        keys: bobKeys,
      }),
    );
  });

  it("signs and verifies ML-DSA-87 commitment digests and catches single-bit tampering", async () => {
    const acc = await deriveUnifiedAccount(generateMnemonic(128), 0);
    assert.equal(acc.pqc.publicKey.length, 2592, "ML-DSA-87 public key must be 2,592 bytes");

    const digest = hexToBytes(keccak256(stringToHex("blindintent-test-commitment")));
    const sig = pqcSign(acc.pqc.secretKey, digest);
    assert.equal(sig.length, 4627, "ML-DSA-87 signature must be 4,627 bytes");
    assert.equal(pqcVerify(acc.pqc.publicKey, digest, sig), true);

    const corrupted = new Uint8Array(sig);
    corrupted[16] ^= 0x01;
    assert.equal(pqcVerify(acc.pqc.publicKey, digest, corrupted), false);
  });

  it("produces 32-byte evmAuthSignBytesV2 digests bound to gasLimit and nonce", () => {
    const d1 = evmAuthSignBytesV2({
      chainId: "qorechain-diana",
      account: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8u8695",
      pubkey: new Uint8Array(20).fill(0xab),
      to: "0x000000000000000000000000000000000000b1ad",
      value: "0",
      data: new Uint8Array([0x01, 0x02]),
      nonce: 0n,
      gasLimit: 350_000n,
    });
    const d2 = evmAuthSignBytesV2({
      chainId: "qorechain-diana",
      account: "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8u8695",
      pubkey: new Uint8Array(20).fill(0xab),
      to: "0x000000000000000000000000000000000000b1ad",
      value: "0",
      data: new Uint8Array([0x01, 0x02]),
      nonce: 1n,
      gasLimit: 350_000n,
    });

    assert.equal(d1.length, 32);
    assert.notDeepEqual(d1, d2);
  });

  it("parses plain-English sell and buy intents deterministically without an API key", async () => {
    const sellSpec = await compileIntentPrompt(
      "Protect 0.25 fETH: sell to fUSD if fETH drops below 2950, max 0.5% slippage, 48h",
      3200,
    );
    assert.equal(sellSpec.tokenIn, "fETH");
    assert.equal(sellSpec.tokenOut, "fUSD");
    assert.equal(sellSpec.amountInDisplay, "0.25");
    assert.equal(sellSpec.triggerPriceUsd, 2950);
    assert.equal(sellSpec.maxSlippageBps, 50);
    assert.equal(sellSpec.durationHours, 48);

    const dipSpec = parseIntentDeterministic("Sell 0.1 fETH when drops 5%", 3200);
    assert.equal(dipSpec.triggerPriceUsd, 3040);

    const buySpec = parseIntentDeterministic("Buy 0.005 fBTC with fUSD below $92000 for 72 hours", 3200);
    assert.equal(buySpec.action, "buy");
    assert.equal(buySpec.tokenIn, "fUSD");
    assert.equal(buySpec.tokenOut, "fBTC");
    assert.equal(buySpec.triggerPriceUsd, 92000);
    assert.equal(buySpec.durationHours, 72);
  });
});
