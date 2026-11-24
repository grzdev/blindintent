import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { verifySiwqWithChain } from "@qorechain/qoresign/network";
import { QORE_CONFIG } from "./config.js";
import { BlindIntentEngine } from "./blindIntentEngine.js";
import { compileIntentPrompt } from "./intentCompiler.js";
import { fetchChainTelemetry } from "./qoreClient.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const engine = new BlindIntentEngine();
const siwqNonces = new Map<string, number>();

function clientIp(req: express.Request): string {
  return String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "local");
}

app.get("/api/health", async (_req, res) => {
  try {
    const [telemetry, identity] = await Promise.all([
      fetchChainTelemetry(),
      engine.getIdentityStatus(),
    ]);
    res.json({ ok: true, telemetry, identity, ordersCount: engine.listOrders().length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/orders", (_req, res) => {
  res.json({ orders: engine.listOrders() });
});

app.post("/api/intent/parse", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt ?? "");
    const telemetry = await fetchChainTelemetry();
    const spec = await compileIntentPrompt(prompt, telemetry.liveEthUsdReference);
    res.json({ spec, referenceEthUsd: telemetry.liveEthUsdReference });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/intent/seal", async (req, res) => {
  try {
    engine.checkRateLimit(clientIp(req));
    const prompt = String(req.body?.prompt ?? "");
    const order = await engine.sealIntent(prompt);
    res.json({ order });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/orders/:id/decrypt", (req, res) => {
  try {
    const decrypted = engine.decryptOrderForUi(req.params.id);
    res.json({ decrypted });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/agent/evaluate", async (req, res) => {
  try {
    engine.checkRateLimit(clientIp(req));
    const orderId = String(req.body?.orderId ?? "");
    const simulatedMarketPriceUsd =
      req.body?.simulatedMarketPriceUsd !== undefined
        ? Number(req.body.simulatedMarketPriceUsd)
        : undefined;
    const outcome = await engine.evaluateAndExecute(orderId, simulatedMarketPriceUsd);
    res.json(outcome);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/attack/simulate", async (req, res) => {
  try {
    engine.checkRateLimit(clientIp(req));
    const attackType = req.body?.attackType as
      | "unauthorized-target"
      | "over-spend-cap"
      | "pqc-signature-tamper";
    const orderId = req.body?.orderId ? String(req.body.orderId) : undefined;
    const attack = await engine.simulateAttack(attackType, orderId);
    res.json({ attack });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/siwq/nonce", (_req, res) => {
  const nonce = crypto.randomBytes(8).toString("hex");
  siwqNonces.set(nonce, Date.now());
  // Prune nonces older than 10 minutes
  for (const [k, ts] of siwqNonces.entries()) {
    if (Date.now() - ts > 600_000) siwqNonces.delete(k);
  }
  res.json({ nonce, chainId: QORE_CONFIG.chainId });
});

app.post("/api/siwq/verify", async (req, res) => {
  try {
    const { address, message, signature, domain, nonce } = req.body ?? {};
    if (!siwqNonces.has(String(nonce))) {
      res.status(400).json({ error: "Unknown or expired SIWQ nonce" });
      return;
    }
    siwqNonces.delete(String(nonce));
    const fields = await verifySiwqWithChain({
      rest: QORE_CONFIG.restUrl,
      address: String(address),
      message: String(message),
      signature,
      domain: String(domain),
      nonce: String(nonce),
      chainId: QORE_CONFIG.chainId,
    });
    res.json({ verified: true, fields });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Proxy /lcd-testnet/* so production single-server deployments also bypass CORS
app.use("/lcd-testnet", async (req, res) => {
  try {
    const upstreamUrl = `${QORE_CONFIG.restUrl}${req.url}`;
    const r = await fetch(upstreamUrl, {
      method: req.method,
      headers: { accept: "application/json" },
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`BlindIntent Agent & Relayer Server listening on http://127.0.0.1:${port}`);
});
