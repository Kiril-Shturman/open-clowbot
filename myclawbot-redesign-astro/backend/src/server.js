import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { healthRouter } from './routes/health.js';
import { paymentsRouter } from './routes/payments.js';
import { billingRouter } from './routes/billing.js';
import { aiRouter } from './routes/ai.js';
import { infraRouter } from './routes/infra.js';
import { keysRouter } from './routes/keys.js';
import { deployRouter } from './routes/deploy.js';
import { subscriptionsRouter } from './routes/subscriptions.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.json({ service: 'myclawbot-backend', ok: true }));
app.use('/health', healthRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/ai', aiRouter);
app.use('/api/infra', infraRouter);
app.use('/api/keys', keysRouter);
app.use('/api/deploy', deployRouter);
app.use('/api/subscriptions', subscriptionsRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', detail: String(err.message || err) });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Backend listening on :${port}`);
});
