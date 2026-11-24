import { useEffect, useState } from "react";
import { ExecutionAndAttackLab } from "./components/ExecutionAndAttackLab.js";
import { HeaderBar } from "./components/HeaderBar.js";
import { INTENT_PRESETS, IntentComposer, type IntentPreset } from "./components/IntentComposer.js";
import { PrivacyXRay } from "./components/PrivacyXRay.js";
import type {
  AttackResult,
  CompiledIntentSpec,
  DecryptedOrderPayload,
  HealthPayload,
  SealedOrderRecord,
} from "./types.js";

export function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [walletMode, setWalletMode] = useState<"sandbox" | "qorex">("sandbox");
  const [prompt, setPrompt] = useState(INTENT_PRESETS[0].prompt);
  const [activePresetId, setActivePresetId] = useState<string | null>(INTENT_PRESETS[0].id);
  const [previewSpec, setPreviewSpec] = useState<CompiledIntentSpec | null>(null);

  const [activeOrder, setActiveOrder] = useState<SealedOrderRecord | null>(null);
  const [decrypted, setDecrypted] = useState<DecryptedOrderPayload | null>(null);
  const [unlocked, setUnlocked] = useState(true);

  const [sealing, setSealing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evalMessage, setEvalMessage] = useState<string | null>(null);
  const [simulatedPriceUsd, setSimulatedPriceUsd] = useState<number>(3200);

  const [attackLoading, setAttackLoading] = useState<string | null>(null);
  const [attackResults, setAttackResults] = useState<AttackResult[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthPayload) => {
        setHealth(data);
        if (data.telemetry?.liveEthUsdReference) {
          setSimulatedPriceUsd(data.telemetry.liveEthUsdReference);
        }
      })
      .catch((err) => {
        setErrorBanner(err instanceof Error ? err.message : "Failed to reach BlindIntent backend");
      });
  }, []);

  // Debounced live compile preview
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!prompt.trim()) return;
      fetch("/api/intent/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      })
        .then((r) => r.json())
        .then((d: { spec?: CompiledIntentSpec }) => {
          if (d.spec) setPreviewSpec(d.spec);
        })
        .catch(() => {});
    }, 180);
    return () => clearTimeout(timer);
  }, [prompt]);

  async function handleSealAndArm() {
    setErrorBanner(null);
    setEvalMessage(null);
    setSealing(true);
    try {
      const res = await fetch("/api/intent/seal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = (await res.json()) as { order?: SealedOrderRecord; error?: string };
      if (!res.ok || !body.order) throw new Error(body.error ?? "Failed to seal intent");
      setActiveOrder(body.order);
      setUnlocked(true);

      const decRes = await fetch(`/api/orders/${body.order.id}/decrypt`);
      if (decRes.ok) {
        const decData = (await decRes.json()) as { decrypted?: DecryptedOrderPayload };
        setDecrypted(decData.decrypted ?? null);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSealing(false);
    }
  }

  async function handleEvaluateMarket(overridePrice?: number) {
    if (!activeOrder) return;
    setErrorBanner(null);
    setEvaluating(true);
    try {
      const res = await fetch("/api/agent/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: activeOrder.id,
          simulatedMarketPriceUsd: overridePrice ?? simulatedPriceUsd,
        }),
      });
      const data = (await res.json()) as {
        triggered?: boolean;
        reason?: string;
        order?: SealedOrderRecord;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Evaluation failed");
      if (data.order) setActiveOrder(data.order);
      if (data.reason) setEvalMessage(data.reason);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setEvaluating(false);
    }
  }

  async function handleRunAttack(attackType: AttackResult["attackType"]) {
    setErrorBanner(null);
    setAttackLoading(attackType);
    try {
      const res = await fetch("/api/attack/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attackType, orderId: activeOrder?.id }),
      });
      const data = (await res.json()) as { attack?: AttackResult; error?: string };
      if (!res.ok || !data.attack) throw new Error(data.error ?? "Simulation failed");
      setAttackResults((prev) => [data.attack!, ...prev].slice(0, 8));
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setAttackLoading(null);
    }
  }

  function handleSelectPreset(preset: IntentPreset) {
    setActivePresetId(preset.id);
    setPrompt(preset.prompt);
  }

  return (
    <div className="min-h-screen bg-[#07090C] px-4 py-4 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-4">
        <HeaderBar health={health} walletMode={walletMode} onChangeMode={setWalletMode} />

        {errorBanner && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            {errorBanner}
          </div>
        )}

        <IntentComposer
          prompt={prompt}
          activePresetId={activePresetId}
          previewSpec={previewSpec}
          sealing={sealing}
          onSelectPreset={handleSelectPreset}
          onChangePrompt={(v) => {
            setActivePresetId(null);
            setPrompt(v);
          }}
          onSealAndArm={handleSealAndArm}
        />

        <PrivacyXRay
          order={activeOrder}
          decrypted={decrypted}
          unlocked={unlocked}
          onToggleUnlock={() => setUnlocked((u) => !u)}
        />

        <ExecutionAndAttackLab
          order={activeOrder}
          referenceEthUsd={health?.telemetry?.liveEthUsdReference ?? 3200}
          simulatedPriceUsd={simulatedPriceUsd}
          evaluating={evaluating}
          evalMessage={evalMessage}
          attackLoading={attackLoading}
          attackResults={attackResults}
          onChangeSimPrice={setSimulatedPriceUsd}
          onEvaluateMarket={handleEvaluateMarket}
          onRunAttack={handleRunAttack}
        />
      </div>
    </div>
  );
}
