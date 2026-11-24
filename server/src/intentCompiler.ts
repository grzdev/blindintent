import type { TokenSymbol } from "./config.js";

export interface CompiledIntentSpec {
  title: string;
  rawPrompt: string;
  action: "sell" | "buy";
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountInDisplay: string;
  triggerDirection: "below" | "above";
  triggerPriceUsd: number;
  maxSlippageBps: number;
  durationHours: number;
  capPerTxDisplay: string;
  capDailyDisplay: string;
  parserMode: "llm" | "deterministic";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function parseIntentDeterministic(
  prompt: string,
  referenceEthUsd = 3200,
): CompiledIntentSpec {
  const clean = prompt.trim() || "Protect 0.05 fETH: sell to fUSD if fETH drops below 3050, max 0.5% slippage, 24h";
  const lower = clean.toLowerCase();

  const isBuy = /\b(buy|accumulate|dca|swap\s+fusd)\b/i.test(lower) && !/\bsell\b/i.test(lower);
  const mentionsBtc = /\bfbtc\b|\bbtc\b/.test(lower);

  let tokenIn: TokenSymbol = isBuy ? "fUSD" : mentionsBtc ? "fBTC" : "fETH";
  let tokenOut: TokenSymbol = isBuy ? (mentionsBtc ? "fBTC" : "fETH") : "fUSD";
  if (lower.includes("fusd to feth") || lower.includes("fusd -> feth")) {
    tokenIn = "fUSD";
    tokenOut = "fETH";
  } else if (lower.includes("feth to fusd") || lower.includes("feth -> fusd")) {
    tokenIn = "fETH";
    tokenOut = "fUSD";
  }

  // Extract first explicit token amount e.g. "0.05 fETH" or "100 fUSD"
  const amountMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:f?eth|f?usd|f?btc)/i);
  const parsedAmount = amountMatch ? Number(amountMatch[1]) : tokenIn === "fUSD" ? 50 : 0.05;
  const safeAmount = clamp(Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0.05, 0.001, 5000);

  // Extract explicit dollar trigger or percentage drop
  const priceMatch = clean.match(/(?:below|under|drops?\s+to|<|>=?|above)\s*\$?(\d+(?:,\d{3})*(?:\.\d+)?)/i);
  const pctDropMatch = clean.match(/(\d+(?:\.\d+)?)\s*%\s*(?:drop|dip|down|lower)/i) ||
    clean.match(/(?:drop|drops|dip|dips)\s*(\d+(?:\.\d+)?)\s*%/i);

  let triggerPriceUsd = referenceEthUsd * 0.96;
  if (priceMatch) {
    const p = Number(priceMatch[1].replace(/,/g, ""));
    if (Number.isFinite(p) && p > 1) triggerPriceUsd = p;
  } else if (pctDropMatch) {
    const pct = clamp(Number(pctDropMatch[1]), 0.5, 50);
    triggerPriceUsd = Number((referenceEthUsd * (1 - pct / 100)).toFixed(2));
  }

  const triggerDirection: "below" | "above" = /\b(above|rises|exceeds|>)\b/i.test(lower) ? "above" : "below";

  const slipMatch = clean.match(/(\d+(?:\.\d+)?)\s*%\s*slippage/i) || clean.match(/slippage\s*(?:of|max)?\s*(\d+(?:\.\d+)?)\s*%/i);
  const slippagePct = slipMatch ? clamp(Number(slipMatch[1]), 0.1, 10) : 0.8;
  const maxSlippageBps = Math.round(slippagePct * 100);

  const hoursMatch = clean.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)/i);
  const daysMatch = clean.match(/(\d+)\s*(?:d|day|days)/i);
  const durationHours = hoursMatch
    ? clamp(Number(hoursMatch[1]), 1, 720)
    : daysMatch
      ? clamp(Number(daysMatch[1]) * 24, 1, 720)
      : 24;

  const amountStr = safeAmount.toString();
  const dailyStr = Number((safeAmount * 2).toFixed(tokenIn === "fUSD" ? 2 : 4)).toString();

  return {
    title:
      tokenIn === "fUSD"
        ? `Stealth Accumulate ${tokenOut}`
        : `Stop-Loss Vault (${tokenIn} -> ${tokenOut})`,
    rawPrompt: clean,
    action: isBuy ? "buy" : "sell",
    tokenIn,
    tokenOut,
    amountInDisplay: amountStr,
    triggerDirection,
    triggerPriceUsd: Number(triggerPriceUsd.toFixed(2)),
    maxSlippageBps,
    durationHours,
    capPerTxDisplay: amountStr,
    capDailyDisplay: dailyStr,
    parserMode: "deterministic",
  };
}

export async function compileIntentPrompt(
  prompt: string,
  referenceEthUsd = 3200,
): Promise<CompiledIntentSpec> {
  const fallback = parseIntentDeterministic(prompt, referenceEthUsd);
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  if (!geminiKey && !openaiKey) {
    return fallback;
  }

  const systemInstruction =
    `Parse a DeFi order goal into strict JSON matching keys: ` +
    `{"title":string,"action":"sell"|"buy","tokenIn":"fETH"|"fUSD"|"fBTC","tokenOut":"fUSD"|"fETH"|"fBTC",` +
    `"amountInDisplay":string,"triggerDirection":"below"|"above","triggerPriceUsd":number,"maxSlippageBps":number,"durationHours":number}. ` +
    `Reference fETH/fUSD price is ${referenceEthUsd}. Keep maxSlippageBps in [10..1000] and durationHours in [1..720]. Return JSON only.`;

  try {
    let rawJsonText = "";
    if (geminiKey) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${systemInstruction}\nUser goal: ${prompt}` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
          }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        rawJsonText = body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      }
    } else if (openaiKey) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          temperature: 0.1,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        rawJsonText = body.choices?.[0]?.message?.content ?? "";
      }
    }

    if (!rawJsonText) return fallback;
    const parsed = JSON.parse(rawJsonText) as Partial<CompiledIntentSpec>;
    const validToken = (t: unknown): t is TokenSymbol => t === "fETH" || t === "fUSD" || t === "fBTC";
    const tokenIn = validToken(parsed.tokenIn) ? parsed.tokenIn : fallback.tokenIn;
    const tokenOut = validToken(parsed.tokenOut) && parsed.tokenOut !== tokenIn ? parsed.tokenOut : fallback.tokenOut;
    const amt = Number(parsed.amountInDisplay);
    const amountInDisplay = Number.isFinite(amt) && amt > 0 ? clamp(amt, 0.001, 5000).toString() : fallback.amountInDisplay;
    const triggerPriceUsd =
      typeof parsed.triggerPriceUsd === "number" && Number.isFinite(parsed.triggerPriceUsd) && parsed.triggerPriceUsd > 1
        ? Number(parsed.triggerPriceUsd.toFixed(2))
        : fallback.triggerPriceUsd;

    return {
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : fallback.title,
      rawPrompt: prompt,
      action: parsed.action === "buy" ? "buy" : "sell",
      tokenIn,
      tokenOut,
      amountInDisplay,
      triggerDirection: parsed.triggerDirection === "above" ? "above" : "below",
      triggerPriceUsd,
      maxSlippageBps: clamp(Number(parsed.maxSlippageBps) || fallback.maxSlippageBps, 10, 1000),
      durationHours: clamp(Number(parsed.durationHours) || fallback.durationHours, 1, 720),
      capPerTxDisplay: amountInDisplay,
      capDailyDisplay: Number((Number(amountInDisplay) * 2).toFixed(tokenIn === "fUSD" ? 2 : 4)).toString(),
      parserMode: "llm",
    };
  } catch {
    return fallback;
  }
}
