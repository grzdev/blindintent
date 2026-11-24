import { Loader2, Lock, Sparkles, Shield } from "lucide-react";
import type { CompiledIntentSpec } from "../types.js";

export interface IntentPreset {
  id: string;
  label: string;
  badge: string;
  prompt: string;
}

export const INTENT_PRESETS: IntentPreset[] = [
  {
    id: "stop-loss",
    label: "Stop-Loss Vault",
    badge: "-4% Protection",
    prompt: "Protect 0.02 fETH: sell to fUSD if fETH drops 4%, max 0.8% slippage, 24h",
  },
  {
    id: "stealth-dca",
    label: "Stealth Accumulator",
    badge: "Hidden Limit",
    prompt: "Buy 0.01 fETH using 50 fUSD if fETH drops 6%, max 1% slippage, 48h",
  },
  {
    id: "strict-cap",
    label: "Strict Cap Treasury",
    badge: "Attack-Lab Ready",
    prompt: "Sell 0.015 fETH to fUSD if fETH drops 3%, max 0.5% slippage, 24h",
  },
];

interface Props {
  prompt: string;
  activePresetId: string | null;
  previewSpec: CompiledIntentSpec | null;
  sealing: boolean;
  onSelectPreset: (preset: IntentPreset) => void;
  onChangePrompt: (next: string) => void;
  onSealAndArm: () => void;
}

export function IntentComposer({
  prompt,
  activePresetId,
  previewSpec,
  sealing,
  onSelectPreset,
  onChangePrompt,
  onSealAndArm,
}: Props) {
  return (
    <section className="rounded-2xl border border-[#1D2635] bg-[#0D1117]/95 p-4 shadow-xl shadow-black/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="mono text-[11px] font-semibold uppercase tracking-wider text-[#00D4B8]">
            Step 1 · Plain-English Intent &amp; Policy Compiler
          </span>
          <h2 className="mt-0.5 text-base font-semibold text-white">
            Describe your strategy — we hide your trigger &amp; cap the agent automatically
          </h2>
        </div>

        <div className="flex flex-wrap gap-2">
          {INTENT_PRESETS.map((p) => {
            const active = activePresetId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPreset(p)}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "border-[#00D4B8] bg-[#042F2E] text-[#5EEAD4]"
                    : "border-[#1D2635] bg-[#131922] text-slate-300 hover:border-slate-600 hover:text-white"
                }`}
              >
                <span>{p.label}</span>
                <span className="rounded bg-black/40 px-1.5 py-0.5 mono text-[10px] text-slate-400">
                  {p.badge}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row">
        <div className="relative flex-1">
          <input
            type="text"
            value={prompt}
            onChange={(e) => onChangePrompt(e.target.value)}
            placeholder="e.g. Protect 0.05 fETH: sell to fUSD if fETH drops below $3,050, max 0.8% slippage, 24h"
            className="w-full rounded-xl border border-[#1D2635] bg-[#07090C] px-4 py-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-[#00D4B8]"
          />
          {previewSpec && (
            <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-1 rounded-md border border-[#1D2635] bg-[#131922] px-2 py-0.5 mono text-[10px] text-slate-400 sm:inline-flex">
              <Sparkles className="h-3 w-3 text-[#00D4B8]" />
              {previewSpec.parserMode === "llm" ? "AI Compiled" : "Compiled Live"}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onSealAndArm}
          disabled={sealing || !prompt.trim()}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#00D4B8] px-6 py-3 text-sm font-semibold text-[#07090C] shadow-lg shadow-[#00D4B8]/15 transition hover:bg-[#19ebd0] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sealing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {sealing ? "Sealing ML-KEM-1024..." : "Seal Intent & Arm Agent"}
        </button>
      </div>

      {/* Live Preview of Public Guardrails vs Private Encrypted Fields */}
      {previewSpec && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl border border-[#1D2635] bg-[#07090C]/80 px-4 py-2.5 text-xs">
            <div className="flex items-center gap-2 text-slate-300">
              <Shield className="h-4 w-4 text-amber-400" />
              <span>Public On-Chain Agent Cap</span>
            </div>
            <div className="mono text-[11px] text-amber-300">
              Max {previewSpec.capPerTxDisplay} {previewSpec.tokenIn}/tx · BlindIntentVault · {previewSpec.durationHours}h
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-[#00D4B8]/25 bg-[#042F2E]/30 px-4 py-2.5 text-xs">
            <div className="flex items-center gap-2 text-slate-300">
              <Lock className="h-4 w-4 text-[#00D4B8]" />
              <span>Hidden Inside QoreSeal (ML-KEM-1024)</span>
            </div>
            <div className="mono text-[11px] text-[#5EEAD4]">
              Trigger {previewSpec.triggerDirection} ${previewSpec.triggerPriceUsd.toLocaleString()} · {(previewSpec.maxSlippageBps / 100).toFixed(2)}% slip
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
