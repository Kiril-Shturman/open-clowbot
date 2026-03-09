import { query } from '../db.js';

const DEFAULT_INPUT_USD_PER_MTOK = 0.5;
const DEFAULT_OUTPUT_USD_PER_MTOK = 1.5;
const USD_TO_RUB = Number(process.env.USD_TO_RUB || 95);
const MODELS_CACHE_TTL_MS = Number(process.env.OPENROUTER_MODELS_CACHE_TTL_MS || 10 * 60 * 1000);

let modelsCache = {
  loadedAt: 0,
  byId: new Map(),
};

function normalizePriceToUsdPerMTok(rawPerToken) {
  const perToken = Number(rawPerToken || 0);
  if (!Number.isFinite(perToken) || perToken <= 0) return null;
  return perToken * 1_000_000;
}

async function loadOpenRouterModels() {
  const now = Date.now();
  if (now - modelsCache.loadedAt < MODELS_CACHE_TTL_MS && modelsCache.byId.size > 0) {
    return modelsCache.byId;
  }

  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const headers = { 'Content-Type': 'application/json' };

  if (process.env.OPENROUTER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  }

  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter models fetch failed: ${res.status} ${errText}`);
  }

  const payload = await res.json();
  const arr = Array.isArray(payload?.data) ? payload.data : [];
  const byId = new Map();

  for (const m of arr) {
    const id = m?.id;
    if (!id) continue;

    const inPerMTok = normalizePriceToUsdPerMTok(m?.pricing?.prompt);
    const outPerMTok = normalizePriceToUsdPerMTok(m?.pricing?.completion);
    if (!inPerMTok || !outPerMTok) continue;

    byId.set(id, {
      model: id,
      input_usd_per_mtok: inPerMTok,
      output_usd_per_mtok: outPerMTok,
    });
  }

  modelsCache = { loadedAt: now, byId };
  return byId;
}

export async function getModelPricing(model) {
  const fromDb = await query(
    `select model, input_usd_per_mtok, output_usd_per_mtok from model_prices where model = $1 and is_active = true limit 1`,
    [model],
  );
  if (fromDb.rows.length) return fromDb.rows[0];

  try {
    const models = await loadOpenRouterModels();
    const live = models.get(model);
    if (live) {
      await query(
        `insert into model_prices (model, input_usd_per_mtok, output_usd_per_mtok, is_active)
         values ($1, $2, $3, true)
         on conflict (model) do update
         set input_usd_per_mtok = excluded.input_usd_per_mtok,
             output_usd_per_mtok = excluded.output_usd_per_mtok,
             is_active = true,
             updated_at = now()`,
        [live.model, live.input_usd_per_mtok, live.output_usd_per_mtok],
      );
      return live;
    }
  } catch {
    // fallback below
  }

  return {
    model,
    input_usd_per_mtok: DEFAULT_INPUT_USD_PER_MTOK,
    output_usd_per_mtok: DEFAULT_OUTPUT_USD_PER_MTOK,
  };
}

export function calcCostMinor({ promptTokens, completionTokens, inputUsdPerMTok, outputUsdPerMTok }) {
  const inUsd = (promptTokens / 1_000_000) * Number(inputUsdPerMTok);
  const outUsd = (completionTokens / 1_000_000) * Number(outputUsdPerMTok);
  const rub = (inUsd + outUsd) * USD_TO_RUB;
  return Math.max(1, Math.ceil(rub * 100));
}

export function getPreHoldMinor() {
  return Number(process.env.PREHOLD_MINOR || 500); // 5 RUB
}

export function getDailySpendLimitMinor() {
  return Number(process.env.DAILY_SPEND_LIMIT_MINOR || 50000); // 500 RUB/day
}
