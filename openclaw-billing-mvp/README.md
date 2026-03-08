# openclaw-billing-mvp

MVP proxy/billing layer for OpenRouter.

## What it does
- Receives bot requests on `/v1/chat/completions`
- Checks user balance + daily/monthly limits
- Enforces model allowlist
- Proxies to OpenRouter
- Charges user after response by token usage
- Stores usage log (jsonl)

## Env vars
- `INTERNAL_API_KEY` (required, auth from your bots)
- `OPENROUTER_API_KEY` (required)
- `BILLING_PORT` (default `9191`)
- `OPENROUTER_REFERER` (default `https://open-clawbot.ru`)
- `OPENROUTER_TITLE` (default `open-clawbot.ru`)

## Endpoints
- `GET /health`
- `GET /admin/user/:userId`
- `POST /admin/topup` `{ userId, amountRub }`
- `POST /v1/chat/completions`

Request body for chat proxy:
```json
{
  "userId": "demo_user",
  "botId": "sales_assistant_bot",
  "model": "openai/gpt-4.1-mini",
  "messages": [{"role":"user","content":"Привет"}],
  "max_tokens": 500
}
```

Header required:
- `x-internal-api-key: <INTERNAL_API_KEY>`

## Data files
- `data/users.json`
- `data/usage.jsonl`

## Notes
- Pricing is MVP approximation (`MODEL_PRICING_PER_1K`) and rough USD→RUB conversion.
- Replace with exact provider billing when moving to production.
