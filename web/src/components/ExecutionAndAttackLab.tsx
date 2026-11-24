import { Activity, AlertOctagon, CheckCircle2, ExternalLink, Loader2, ShieldAlert, TrendingDown, Zap } from "lucide-react";
import type { AttackResult, SealedOrderRecord } from "../types.js";

interface Props {
  order: SealedOrderRecord | null;
  referenceEthUsd: number;
  simulatedPriceUsd: number;
  evaluating: boolean;
  evalMessage: string | null;
  attackLoading: string | null;
  attackResults: AttackResult[];
  onChangeSimPrice: (v: number) => void;
  onEvaluateMarket: (overridePrice?: number) => void;
  onRunAttack: (kind: AttackResult["attackType"]) => void;
}

export function ExecutionAndAttackLab({
  order,
  referenceEthUsd,
  simulatedPriceUsd,
  evaluating,
  evalMessage,
  attackLoading,
  attackResults,
  onChangeSimPrice,
  onEvaluateMarket,
  onRunAttack,
}: Props) {
  const triggerUsd = order?.spec.triggerPriceUsd ?? Math.round(referenceEthUsd * 0.96);
  const dipPrice = Math.max(100, Number((triggerUsd * 0.99).toFixed(2)));
  const sliderMin = Math.round(Math.min(referenceEthUsd, triggerUsd) * 0.72);
  const sliderMax = Math.round(Math.max(referenceEthUsd, triggerUsd) * 1.18);

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      {/* LEFT PANEL: MARKET TRIGGER & BOUNDED SETTLEMENT */}
      <div className="rounded-2xl border border-[#1D2635] bg-[#0D1117]/95 p-4 shadow-xl shadow-black/30">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="mono text-[11px] font-semibold uppercase tracking-wider text-[#00D4B8]">
              Step 3A · Autonomous Agent Settlement
            </span>
            <h3 className="mt-0.5 text-base font-semibold text-white">
              Test Market Condition &amp; Execute via <span className="mono text-[#5EEAD4]">MsgExecuteEVM</span>
            </h3>
          </div>
          <span className="rounded-lg border border-[#1D2635] bg-[#131922] px-2.5 py-1 mono text-xs text-slate-300">
            Pool #3: ${referenceEthUsd.toLocaleString()}
          </span>
        </div>

        <div className="mt-4 rounded-xl border border-[#1D2635] bg-[#07090C] p-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Simulated Market Price (Judge Stress Slider)</span>
            <span className="mono text-sm font-bold text-white">${simulatedPriceUsd.toLocaleString()}</span>
          </div>
          <input
            type="range"
            min={sliderMin}
            max={sliderMax}
            step={10}
            value={simulatedPriceUsd}
            onChange={(e) => onChangeSimPrice(Number(e.target.value))}
            className="mt-3 w-full accent-[#00D4B8]"
          />
          <div className="mt-1 flex justify-between mono text-[10px] text-slate-500">
            <span>${sliderMin.toLocaleString()}</span>
            <span>Trigger: ${triggerUsd.toLocaleString()}</span>
            <span>${sliderMax.toLocaleString()}</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={!order || evaluating}
              onClick={() => {
                onChangeSimPrice(dipPrice);
                onEvaluateMarket(dipPrice);
              }}
              className="inline-flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#00D4B8] px-4 py-2.5 text-xs font-semibold text-[#07090C] transition hover:bg-[#19ebd0] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {evaluating ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingDown className="h-4 w-4" />}
              Simulate Price Drop (${dipPrice.toLocaleString()}) &amp; Settle
            </button>

            <button
              type="button"
              disabled={!order || evaluating}
              onClick={() => onEvaluateMarket(simulatedPriceUsd)}
              className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-[#1D2635] bg-[#131922] px-3.5 py-2.5 text-xs font-medium text-slate-200 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Zap className="h-3.5 w-3.5 text-amber-400" />
              Check @ ${simulatedPriceUsd.toLocaleString()}
            </button>
          </div>
        </div>

        {evalMessage && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#1D2635] bg-[#131922] p-3 text-xs text-slate-200">
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-[#00D4B8]" />
            <span>{evalMessage}</span>
          </div>
        )}

        {order?.status === "executed" && (
          <div className="mt-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Verified by 0x...0a01 (pqcVerify) &amp; Settled
              </span>
              {order.settleExplorerUrl && (
                <a
                  href={order.settleExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mono text-[11px] text-sky-300 hover:underline"
                >
                  Explorer Tx <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 mono text-[11px] text-slate-200">
              <div>Settled Out: {order.amountOutDisplay} {order.spec.tokenOut}</div>
              <div>Trigger Market: ${order.settledMarketPriceUsd?.toLocaleString()}</div>
            </div>
            {order.encryptedReceiptText && (
              <div className="mt-2 rounded-lg border border-emerald-500/20 bg-[#07090C]/80 p-2 mono text-[10px] text-slate-400">
                <div className="mb-0.5 text-emerald-300">QoreSeal Encrypted Receipt (blindintent:receipt:v1):</div>
                {order.encryptedReceiptText.slice(0, 120)}...
              </div>
            )}
          </div>
        )}
      </div>

      {/* RIGHT PANEL: INTERACTIVE ATTACK LAB */}
      <div className="rounded-2xl border border-[#1D2635] bg-[#0D1117]/95 p-5 shadow-xl shadow-black/30">
        <div>
          <span className="mono text-[11px] font-semibold uppercase tracking-wider text-rose-400">
            Step 3B · Live Attack Lab (Break My Agent)
          </span>
          <h3 className="mt-0.5 text-base font-semibold text-white">
            Simulate compromised agent &amp; quantum forgery attacks against chain rules
          </h3>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            disabled={attackLoading !== null}
            onClick={() => onRunAttack("unauthorized-target")}
            className="flex cursor-pointer flex-col items-start gap-1 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-left transition hover:border-rose-400 hover:bg-rose-500/20 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-300">
              {attackLoading === "unauthorized-target" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              Prompt Inject Drain
            </span>
            <span className="text-[11px] text-slate-400">Send funds to attacker 0x...dEaD</span>
          </button>

          <button
            type="button"
            disabled={attackLoading !== null}
            onClick={() => onRunAttack("over-spend-cap")}
            className="flex cursor-pointer flex-col items-start gap-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left transition hover:border-amber-400 hover:bg-amber-500/20 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300">
              {attackLoading === "over-spend-cap" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <AlertOctagon className="h-3.5 w-3.5" />
              )}
              10× Over-Cap Spend
            </span>
            <span className="text-[11px] text-slate-400">Exceed per-tx SpendingRule cap</span>
          </button>

          <button
            type="button"
            disabled={attackLoading !== null}
            onClick={() => onRunAttack("pqc-signature-tamper")}
            className="flex cursor-pointer flex-col items-start gap-1 rounded-xl border border-violet-500/30 bg-violet-500/10 p-3 text-left transition hover:border-violet-400 hover:bg-violet-500/20 disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-300">
              {attackLoading === "pqc-signature-tamper" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              Corrupt ML-DSA-87
            </span>
            <span className="text-[11px] text-slate-400">Flip 1 byte of PQ commitment sig</span>
          </button>
        </div>

        <div className="mt-4 max-h-56 space-y-2.5 overflow-y-auto pr-1">
          {attackResults.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#1D2635] bg-[#07090C]/70 p-4 text-center text-xs text-slate-400">
              Click any attack above to verify fail-closed enforcement by <span className="mono text-slate-300">x/abstractaccount</span> and <span className="mono text-slate-300">pqcVerify (0x...0a01)</span>.
            </div>
          ) : (
            attackResults.map((atk, idx) => (
              <div
                key={`${atk.attackType}-${idx}`}
                className="rounded-xl border border-rose-500/30 bg-[#07090C] p-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-white">{atk.title}</span>
                  <span className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 mono text-[10px] font-semibold text-emerald-300">
                    {atk.blocked ? "BLOCKED FAIL-CLOSED" : "UNEXPECTED"}
                  </span>
                </div>
                <div className="mt-1 mono text-[11px] text-amber-300">Enforced by: {atk.enforcedBy}</div>
                <p className="mt-1 text-[11px] text-slate-300">{atk.reason}</p>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 mono text-[10px] text-slate-500">
                  <span>{atk.digestOrCalldataPreview}</span>
                  {atk.explorerUrl && (
                    <a
                      href={atk.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sky-400 hover:underline"
                    >
                      Verify On-Chain <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
