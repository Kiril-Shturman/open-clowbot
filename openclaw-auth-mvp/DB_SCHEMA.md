# Open-ClawBot Auth DB Schema (MVP)

DB file: `openclaw-auth-mvp/auth.db` (SQLite)

## Tables

### `users`
Stores account identities.

| column | type | notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| email | TEXT UNIQUE NOT NULL | login identifier |
| password_hash | TEXT NULL | `salt:hash` (scrypt), null for Google-only users |
| google_sub | TEXT UNIQUE NULL | Google subject id |
| name | TEXT NULL | display name |
| picture | TEXT NULL | avatar URL |
| created_at | TEXT NOT NULL | ISO timestamp |
| updated_at | TEXT NOT NULL | ISO timestamp |

---

### `sessions`
HttpOnly cookie sessions.

| column | type | notes |
|---|---|---|
| token | TEXT PK | random session token |
| user_id | INTEGER NOT NULL | FK → users.id |
| created_at | TEXT NOT NULL | ISO timestamp |
| expires_at | TEXT NOT NULL | ISO timestamp |

---

### `bots`
User-owned bots for multi-bot account management.

| column | type | notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| user_id | INTEGER NOT NULL | FK → users.id |
| name | TEXT NOT NULL | internal bot name |
| telegram_username | TEXT NULL | e.g. `@my_bot` |
| channel | TEXT NOT NULL | default `telegram` |
| status | TEXT NOT NULL | `active` / `paused` |
| created_at | TEXT NOT NULL | ISO timestamp |

---

## Current API ↔ DB mapping

- `POST /api/auth/register` → insert `users`, create `sessions`
- `POST /api/auth/login` → check `users.password_hash`, create `sessions`
- `POST /api/auth/google` → upsert `users` by email/google_sub, create `sessions`
- `GET /api/auth/me` → join `sessions` + `users`
- `POST /api/auth/logout` → delete from `sessions`
- `GET /api/account/bots` → select from `bots` by `user_id`
- `POST /api/account/bots` → insert into `bots`

## Next tables (planned)

- `wallets` (balance per user)
- `wallet_txns` (topups, debits, refunds)
- `bot_limits` (daily/monthly/model limits per bot)
- `usage_events` (token/cost events from billing proxy)
