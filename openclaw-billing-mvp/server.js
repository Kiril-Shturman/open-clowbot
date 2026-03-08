const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BILLING_PORT || 9191);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'change-me-in-env';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const REFERER = process.env.OPENROUTER_REFERER || 'https://open-clawbot.ru';
const TITLE = process.env.OPENROUTER_TITLE || 'open-clawbot.ru';

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USAGE_LOG = path.join(DATA_DIR, 'usage.jsonl');

const MODEL_PRICING_PER_1K = {
  'openai/gpt-4.1-mini': { in: 0.0025, out: 0.01 },
  'anthropic/claude-3.5-sonnet': { in: 0.003, out: 0.015 },
  'google/gemini-2.0-flash-001': { in: 0.001, out: 0.004 },
  default: { in: 0.003, out: 0.012 }
};

ensureFiles();

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    const seed = {
      users: {
        demo_user: {
          balanceRub: 1250,
          dailyLimitRub: 500,
          monthlyLimitRub: 3890,
          allowedModels: [
            'openai/gpt-4.1-mini',
            'anthropic/claude-3.5-sonnet',
            'google/gemini-2.0-flash-001'
          ],
          spentTodayRub: 0,
          spentMonthRub: 0,
          updatedAt: new Date().toISOString()
        }
      }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2));
  }
  if (!fs.existsSync(USAGE_LOG)) fs.writeFileSync(USAGE_LOG, '');
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function loadDb() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function saveDb(db) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2));
}

function appendUsage(entry) {
  fs.appendFileSync(USAGE_LOG, JSON.stringify(entry) + '\n');
}

function estimateRub(model, inTokens = 0, outTokens = 0) {
  const p = MODEL_PRICING_PER_1K[model] || MODEL_PRICING_PER_1K.default;
  // USD to RUB coarse multiplier for MVP
  const usdToRub = 95;
  const usd = (inTokens / 1000) * p.in + (outTokens / 1000) * p.out;
  return Number((usd * usdToRub).toFixed(4));
}

function authOk(req) {
  const key = req.headers['x-internal-api-key'];
  return key && key === INTERNAL_API_KEY;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'openclaw-billing-mvp' });
  }

  if (!authOk(req)) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && req.url.startsWith('/admin/user/')) {
    const userId = decodeURIComponent(req.url.split('/').pop());
    const db = loadDb();
    const u = db.users[userId];
    if (!u) return send(res, 404, { error: 'user_not_found' });
    return send(res, 200, { userId, ...u });
  }

  if (req.method === 'POST' && req.url === '/admin/topup') {
    const { userId, amountRub } = await readJson(req);
    if (!userId || !amountRub) return send(res, 400, { error: 'userId_and_amountRub_required' });
    const db = loadDb();
    if (!db.users[userId]) return send(res, 404, { error: 'user_not_found' });
    db.users[userId].balanceRub += Number(amountRub);
    db.users[userId].updatedAt = new Date().toISOString();
    saveDb(db);
    return send(res, 200, { ok: true, balanceRub: db.users[userId].balanceRub });
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    if (!OPENROUTER_API_KEY) return send(res, 500, { error: 'OPENROUTER_API_KEY_missing' });

    const payload = await readJson(req);
    const userId = payload.userId;
    const botId = payload.botId || 'default_bot';
    const model = payload.model;

    if (!userId || !model || !Array.isArray(payload.messages)) {
      return send(res, 400, { error: 'userId, model, messages[] required' });
    }

    const db = loadDb();
    const user = db.users[userId];
    if (!user) return send(res, 404, { error: 'user_not_found' });

    if (!user.allowedModels.includes(model)) {
      return send(res, 403, { error: 'model_not_allowed' });
    }

    if (user.balanceRub <= 0) return send(res, 402, { error: 'insufficient_balance' });
    if (user.spentTodayRub >= user.dailyLimitRub) return send(res, 429, { error: 'daily_limit_exceeded' });
    if (user.spentMonthRub >= user.monthlyLimitRub) return send(res, 429, { error: 'monthly_limit_exceeded' });

    const precheckRub = 15; // protective reserve for MVP
    if (user.balanceRub < precheckRub) return send(res, 402, { error: 'low_balance_precheck' });

    const orBody = {
      model,
      messages: payload.messages,
      max_tokens: payload.max_tokens || 700,
      temperature: payload.temperature ?? 0.7
    };

    let orResp;
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': REFERER,
          'X-Title': TITLE
        },
        body: JSON.stringify(orBody)
      });
      orResp = await resp.json();
      if (!resp.ok) return send(res, resp.status, { error: 'openrouter_error', details: orResp });
    } catch (e) {
      return send(res, 502, { error: 'openrouter_unreachable', details: String(e.message || e) });
    }

    const inTok = Number(orResp?.usage?.prompt_tokens || 0);
    const outTok = Number(orResp?.usage?.completion_tokens || 0);
    const costRub = estimateRub(model, inTok, outTok);

    user.balanceRub = Number((user.balanceRub - costRub).toFixed(4));
    user.spentTodayRub = Number((user.spentTodayRub + costRub).toFixed(4));
    user.spentMonthRub = Number((user.spentMonthRub + costRub).toFixed(4));
    user.updatedAt = new Date().toISOString();
    saveDb(db);

    appendUsage({
      at: new Date().toISOString(),
      userId,
      botId,
      model,
      inTok,
      outTok,
      costRub,
      balanceAfterRub: user.balanceRub
    });

    return send(res, 200, {
      ...orResp,
      billing: {
        userId,
        botId,
        model,
        costRub,
        balanceAfterRub: user.balanceRub,
        spentTodayRub: user.spentTodayRub,
        spentMonthRub: user.spentMonthRub
      }
    });
  }

  return send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`openclaw-billing-mvp listening on 127.0.0.1:${PORT}`);
});
