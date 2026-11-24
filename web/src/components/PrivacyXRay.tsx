import { Eye, EyeOff, ExternalLink, Lock, ShieldCheck, KeyRound } from "lucide-react";
import type { DecryptedOrderPayload, SealedOrderRecord } from "../types.js";

interface Props {
  order: SealedOrderRecord | null;
  decrypted: DecryptedOrderPayload | null;
  unlocked: boolean;
  onToggleUnlock: () => void;
}

export function PrivacyXRay({ order, decrypted, unlocked, onToggleUnlock }: Props) {
  if (!order) {
    return (
      <section className="rounded-2xl border border-dashed border-[#1D2635] bg-[#0D1117]/60 p-8 text-center">
        <p className="text-sm text-slate-300">
          Pick a preset or type an intent above, then click <strong className="text-[#00D4B8]">Seal Intent &amp; Arm Agent</strong> to inspect the live X-Ray Privacy Split.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-[#1D2635] bg-[#0D1117]/95 p-4 shadow-xl shadow-black/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="mono text-[11px] font-semibold uppercase tracking-wider text-[#00D4B8]">
            Step 2 · X-Ray Privacy Split
          </span>
          <h2 className="mt-0.5 text-base font-semibold text-white">
            Compare what mempool bots / quantum snoops see vs. what your agent decrypts
          </h2>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-0.5 mono text-[11px] font-medium ${
              order.status === "executed"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-[#00D4B8]/40 bg-[#042F2E] text-[#5EEAD4]"
            }`}
          >
            {order.status === "executed"
              ? order.chainMode === "live-onchain"
                ? "EXECUTED ON-CHAIN"
                : "EXECUTED (CRYPTO PREVIEW)"
              : order.chainMode === "live-onchain"
                ? "ARMED ON QORECHAIN"
                : "ARMED (PREVIEW)"}
          </span>
          <button
            type="button"
            onClick={onToggleUnlock}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[#1D2635] bg-[#131922] px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-[#00D4B8]/60 hover:text-[#00D4B8]"
          >
            {unlocked ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {unlocked ? "Hide Plaintext" : "Unlock with KEM Key"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* LEFT CARD: PUBLIC / ATTACKER VIEW */}
        <div className="rounded-xl border border-rose-500/25 bg-[#07090C] p-4">
          <div className="flex items-center justify-between border-b border-[#1D2635] pb-2.5">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-rose-400" />
              <span className="text-sm font-semibold text-white">Public Chain &amp; Mempool View</span>
            </div>
            <span className="rounded bg-rose-500/15 px-2 py-0.5 mono text-[10px] text-rose-300">
              MEV &amp; Q-Day Blind
            </span>
          </div>

          <div className="mt-3 space-y-2.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-400">Commitment Digest</span>
              <span className="mono text-slate-200">{order.commitmentHash.slice(0, 14)}...{order.commitmentHash.slice(-8)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Bounded Spend Ceiling</span>
              <span className="mono text-amber-300">
                Max {order.spec.amountInDisplay} {order.spec.tokenIn} → {order.spec.tokenOut}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Trigger Price / Slippage</span>
              <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 mono text-[11px] text-rose-300">
                █████ REDACTED (ML-KEM-1024) █████
              </span>
            </div>
            <div className="pt-1">
              <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                <span>QoreSeal Hybrid Ciphertext ({order.mlKemEnvelopeBytesLen.toLocaleString()} bytes)</span>
                <span className="mono text-slate-500">X25519 + ML-KEM-1024 + AES-256-GCM</span>
              </div>
              <div className="max-h-20 overflow-hidden break-all rounded-lg border border-[#1D2635] bg-[#0D1117] p-2.5 mono text-[10px] leading-relaxed text-slate-400">
                {order.mlKemEnvelopeText.slice(0, 260)}...
              </div>
            </div>
            {order.registerExplorerUrl && (
              <div className="pt-1">
                <a
                  href={order.registerExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mono text-[11px] text-sky-400 hover:text-sky-300"
                >
                  Inspect on explore.qore.network <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT CARD: AUTHORIZED DECRYPTED VIEW */}
        <div className="rounded-xl border border-[#00D4B8]/30 bg-[#07090C] p-4">
          <div className="flex items-center justify-between border-b border-[#1D2635] pb-2.5">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[#00D4B8]" />
              <span className="text-sm font-semibold text-white">Authorized Agent &amp; Owner View</span>
            </div>
            <span className="rounded bg-[#042F2E] px-2 py-0.5 mono text-[10px] text-[#5EEAD4]">
              ML-DSA-87 Bound
            </span>
          </div>

          {unlocked && decrypted ? (
            <div className="mt-3 space-y-2.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Strategy Goal</span>
                <span className="font-medium text-white">
                  {order.spec.action.toUpperCase()} {order.spec.amountInDisplay} {decrypted.tokenIn} → {decrypted.tokenOut}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Private Execution Trigger</span>
                <span className="mono font-semibold text-[#00D4B8]">
                  When market is {decrypted.triggerDirection} ${decrypted.triggerPriceUsd.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Protected Slippage Tolerance</span>
                <span className="mono text-slate-200">{(decrypted.maxSlippageBps / 100).toFixed(2)}% max</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Owner PQ Signature</span>
                <span className="inline-flex items-center gap-1 mono text-[11px] text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  ML-DSA-87 ({order.ownerPqSigHex.length / 2 - 1}B sig)
                </span>
              </div>
              <div className="rounded-lg border border-[#00D4B8]/25 bg-[#042F2E]/35 p-2.5 text-[11px] text-slate-300">
                Only decapsulated inside authorized QoreSeal domain <span className="mono text-[#5EEAD4]">qorechain-kem-v1|qorechain-diana|blindintent:order:v1</span>. Neither mempool watchers nor future quantum harvesters can read the threshold above.
              </div>
            </div>
          ) : (
            <div className="flex h-44 flex-col items-center justify-center gap-3 text-center">
              <Lock className="h-6 w-6 text-slate-500" />
              <p className="max-w-xs text-xs text-slate-400">
                Plaintext hidden. Click <strong className="text-[#00D4B8]">Unlock with KEM Key</strong> to decapsulate the QoreSeal envelope client-side.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
