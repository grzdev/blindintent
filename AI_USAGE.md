# AI Usage Disclosure — BlindIntent

This repository tracks all AI-assisted design, implementation, and verification workflows for **BlindIntent** in accordance with the **Build Before Q-Day: Best AI-Native Build** special award guidelines.

## 1. Runtime AI Integration (Inside the Product)

- **Plain-English Intent & Policy Compiler (`server/src/intentCompiler.ts`):**
  - Accepts human trading and treasury instructions (e.g., *"Protect 0.05 fETH: sell to fUSD if fETH drops below $3,050, max 0.8% slippage, 24h"*) and compiles structured token pair, trigger threshold, slippage tolerance, TTL duration, and per-tx / rolling daily spending caps (`SpendingRule`).
  - Supports live LLM structured JSON extraction via `GEMINI_API_KEY` or `OPENAI_API_KEY` with strict TypeScript range clamping (`maxSlippageBps` in `[10..1000]`, `durationHours` in `[1..720]`) and a deterministic parser fallback so the demo runs reliably even without external LLM credentials.
- **Least-Privilege Security Model for Autonomous Agents:**
  - Rather than giving the AI agent an unrestricted private key, BlindIntent enforces hard guardrails on-chain using QoreChain's `x/abstractaccount` module (`MsgExecuteEVM`, `allowedEvmCalls`, `perTxLimit`, `dailyLimit`, `expiryUnix`) and Solidity's post-quantum `pqcVerify` (`0x...0a01`) + `pqcKeyStatus` (`0x...0a02`) precompiles.
  - Prompt injections or rogue calls attempting to bypass the vault target or spend above caps revert fail-closed at the protocol layer.

## 2. Engineering & Workflow AI Assistance

- **Architecture & Research:** Used AI assistance (Antigravity) to survey QoreChain `build.qorechain.io` fest requirements, map `docs.qorechain.io` SDK/precompile specifications (`@qorechain/sdk`, `@qorechain/qoreseal`, `@qorechain/qoresign`, `x/abstractaccount` v3.2.8 `possessionProof` + `SpendingRule`), and inspect live `qorechain-diana` `x/amm` pools and active precompile lists.
- **Scaffolding & Code Generation:** Generated the initial Hardhat 3 + Solidity contract boilerplate, Express agent/relayer routes, React + Tailwind Explorer components, and SVG architecture graphics.
- **Human Review, Security & Verification:**
  - Every QoreChain SDK method signature (`evmAuthSignBytesV2`, `executeEvmMsg`, `seal`, `open`, `pqcSign`, `pqcVerify`) was cross-checked directly against installed `@qorechain/*` `.d.ts` definitions and `create-qorechain-dapp` reference templates.
  - Added explicit security invariants in `BlindIntentVault.sol`, including `possessionProven` checks (`0x...0a02`), on-chain `keccak256(onChainPubkey) == keccak256(ownerPqPubkey)` validation (preventing rogue-key spoofing), and internal constant-product reserve pricing (preventing malicious agent `amountOut` drain).
  - Automated Hardhat tests (`contracts/test/BlindIntentVault.test.ts`), backend crypto tests (`server/test/blindIntent.test.ts`), and production frontend builds (`web`) were executed directly to verify correctness.
