import { Router } from 'express';
import { query } from '../db.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    await query('select 1');
    res.json({ ok: true, db: 'up' });
  } catch (error) {
    res.status(500).json({ ok: false, db: 'down', error: String(error.message || error) });
  }
});
