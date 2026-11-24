import { ConnectButton } from "@rainbow-me/rainbowkit";
import { classifyEvmWindowRejection, evmWindowStatus } from "@qorechain/evm";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Sparkles, Wallet, Radio, AlertTriangle } from "lucide-react";
import { useAccount } from "wagmi";
import type { HealthPayload } from "../types.js";

interface Props {
  health: HealthPayload | null;
  walletMode: "sandbox" | "qorex";
  onChangeMode: (m: "sandbox" | "qorex") => void;
}

export function HeaderBar({ health, walletMode, onChangeMode }: Props) {
  const { address, isConnected } = useAccount();
  const telemetry = health?.telemetry;
  const identity = health?.identity;

  const { data: qorexStatus } = useQuery({
    queryKey: ["qorex-readiness", address],
    enabled: walletMode === "qorex" && Boolean(address),
    queryFn: async () => {
      const [win, kem] = await Promise.all([
        evmWindowStatus({ rest: "/lcd-testnet", address: address! }).catch(() => null),
        fetchKemKey({ rest: "/lcd-testnet", address: address! }).catch(() => null),
      ]);
      return { win, kem };
    },
    refetchInterval: 12_000,
  });

  return (
    <header className="rounded-2xl border border-[#1D2635] bg-[#0D1117]/95 px-5 py-4 shadow-xl shadow-black/40">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#00D4B8]/40 bg-[#042F2E]/70 text-[#00D4B8]">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-white">BlindIntent</h1>
              <span className="rounded-full border border-[#00D4B8]/35 bg-[#042F2E]/60 px-2.5 py-0.5 mono text-[11px] font-medium text-[#5EEAD4]">
                {telemetry?.chainId ?? "qorechain-diana"} · EVM {telemetry?.evmChainId ?? 9800}
              </span>
              {telemetry?.pqcVerifyActive && (
                <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-0.5 mono text-[11px] text-amber-300">
                  0x...0a01 / 0a02 Active
                </span>
              )}
              {telemetry?.latestHeight && (
                <span className="hidden items-center gap-1 rounded-full border border-[#1D2635] bg-[#131922] px-2.5 py-0.5 mono text-[11px] text-slate-300 sm:inline-flex">
                  <Radio className="h-3 w-3 text-emerald-400" />
                  #{telemetry.latestHeight.toLocaleString()}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              MEV-proof ML-KEM-1024 sealed orders executed under on-chain <span className="mono text-slate-300">MsgExecuteEVM</span> spending caps
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex rounded-xl border border-[#1D2635] bg-[#07090C] p-1">
            <button
              type="button"
              onClick={() => onChangeMode("sandbox")}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                walletMode === "sandbox"
                  ? "bg-[#00D4B8] text-[#07090C] shadow"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Instant Judge Sandbox
            </button>
            <button
              type="button"
              onClick={() => onChangeMode("qorex")}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                walletMode === "qorex"
                  ? "bg-amber-400 text-[#07090C] shadow"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              <Wallet className="h-3.5 w-3.5" />
              My QoreX Wallet
            </button>
          </div>

          {walletMode === "qorex" && <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />}
        </div>
      </div>

      {/* Zero-confusion status bar */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#1D2635]/80 pt-3 text-xs">
        {walletMode === "sandbox" ? (
          <div className="flex flex-wrap items-center gap-3 text-slate-300">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 mono text-[11px] ${
                identity?.mode === "live-onchain"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-300"
              }`}
            >
              {identity?.mode === "live-onchain"
                ? "LIVE QORECHAIN TESTNET SANDBOX"
                : "LOCAL PQC CRYPTO PREVIEW (Awaiting Testnet Faucet Funding)"}
            </span>
            {identity && (
              <span className="mono text-[11px] text-slate-400">
                Owner: <span className="text-slate-200">{identity.ownerCosmos.slice(0, 14)}...</span> · Agent Key:{" "}
                <span className="text-slate-200">{identity.agentEvm.slice(0, 10)}...</span>
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-slate-300">
            {!isConnected ? (
              <span className="text-amber-300">Connect your QoreX wallet above (Switch to Testnet).</span>
            ) : (
              <>
                <span className="rounded-md border border-[#1D2635] bg-[#131922] px-2 py-0.5 mono text-[11px]">
                  KEM Registry:{" "}
                  <strong className={qorexStatus?.kem?.registered ? "text-emerald-300" : "text-amber-300"}>
                    {qorexStatus?.kem?.registered ? "Registered (ML-KEM-1024)" : "Not Registered Yet"}
                  </strong>
                </span>
                <span className="rounded-md border border-[#1D2635] bg-[#131922] px-2 py-0.5 mono text-[11px]">
                  EVM Window:{" "}
                  <strong className={qorexStatus?.win?.live ? "text-emerald-300" : "text-amber-300"}>
                    {qorexStatus?.win?.live
                      ? `Live (${qorexStatus.win.remainingTxs.toString()} txs left)`
                      : "Needs Open Window"}
                  </strong>
                </span>
                {(!qorexStatus?.kem?.registered || !qorexStatus?.win?.live) && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-300/90">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Tip: Switch to Instant Judge Sandbox anytime to execute full on-chain flows with zero setup.
                  </span>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 mono text-[11px] text-slate-400">
          <span>
            Live x/amm Pool #3 (fETH):{" "}
            <strong className="text-[#00D4B8]">${telemetry?.liveEthUsdReference?.toLocaleString() ?? "3,200"}</strong>
          </span>
          {identity?.vaultAddress && (
            <a
              href={`https://explore.qore.network/address/${identity.vaultAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 underline decoration-sky-500/40 hover:text-sky-300"
            >
              Vault ↗
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

void classifyEvmWindowRejection;
