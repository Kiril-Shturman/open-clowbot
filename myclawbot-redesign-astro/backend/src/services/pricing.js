import { query } from '../db.js';

const DEFAULT_INPUT_USD_PER_MTOK = 0.5;
const DEFAULT_OUTPUT_USD_PER_MTOK = 1.5;
const USD_TO_RUB = Number(process.env.USD_TO_RUB || 95);

export async function getModelPricing(model) {
  const fromDb = await query(
    `select model, input_usd_per_mtok, output_usd_per_mtok from model_prices where model = $1 and is_active = true limit 1`,
    [model],
  );
  if (fromDb.rows.length) return fromDb.rows[0];
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
