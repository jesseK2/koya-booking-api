# Koya Clinic — booking API

A clinic appointment API plus the web page that uses it, built against the Koya Cohort 4 assessment
spec (`koyaacademy.com/assessment-api`). All five levels are implemented: listing and booking,
API-key auth and validation, race-safe single booking per slot with cancellation, idempotent retries
with cursor pagination, and per-email rate limiting.

**API base URL:** _see the deployment section_
**Web page:** _see the deployment section_

## How it is built

```
api/[...path].js     Vercel function entry (one catch-all, routes internally)
src/app.js           routing + business rules, framework-free
src/db.js            Postgres access; PGlite in-process Postgres for local dev
src/schema.sql       tables and the unique index that prevents double booking
src/server.js        plain node http server for local development
public/              the web page (no build step, no framework)
test/e2e.mjs         20 HTTP-level checks, one per behaviour across the five levels
```

Node only, one runtime dependency (`pg`). Hosted on Vercel as a single serverless function with a
Neon Postgres database, so bookings survive deploys, cold starts, and concurrent instances.

## Endpoints

Every request needs `X-API-Key`. Missing or wrong key → `401 {"error":"…"}`.
Every error is `{"error": "<message>"}`.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/reset` | deletes every booking and replaces all slots, past slots included → `200` |
| `GET` | `/slots` | every slot earliest-first, `?provider=` exact match, each with `available` |
| `POST` | `/bookings` | levels 1–5 → `201`, `400`, `404`, `409`, `422`, `429` |
| `GET` | `/bookings?email=` | that person's bookings oldest-first, `?limit=` 1–50, cursor pagination |
| `GET` | `/bookings/{id}` | `200` or `404` |
| `DELETE` | `/bookings/{id}` | cancels and frees the slot → `200`, `404`, `409` if already cancelled |

```bash
curl -X POST https://YOUR-HOST/reset \
  -H 'x-api-key: YOUR-KEY' -H 'content-type: application/json' \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"}]}'

curl -X POST https://YOUR-HOST/bookings \
  -H 'x-api-key: YOUR-KEY' -H 'content-type: application/json' \
  -H 'Idempotency-Key: 8f2c1d' \
  -d '{"slot_id":"s1","name":"Ada Obi","email":"ada@example.com"}'
```

## How each level is met

**Level 1 — list, book, look up.** `GET /slots` sorts by the parsed start time and echoes the exact
`start`/`end` strings it was given, so a round trip never rewrites the caller's timestamps.

**Level 2 — auth and validation.** `X-API-Key` is compared with `crypto.timingSafeEqual`. `name` and
`email` are trimmed, `email` is stored lower case, and the email must look like an address.
Missing/empty fields and malformed JSON are `400`; an unknown slot is `404`; a slot whose start is in
the past is `400`.

**Level 3 — no double booking.** The rule lives in the database, not in application code:

```sql
CREATE UNIQUE INDEX bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
```

The insert is a single `INSERT … ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
RETURNING …`. If two requests land at the same instant, Postgres lets exactly one row through and the
loser gets no row back, which becomes `409`. No read-then-write window exists. Cancelling sets
`status = 'cancelled'`, which drops the row out of the partial index, so the slot is bookable again.

**Level 4 — retries and pagination.** `Idempotency-Key` is claimed with an `INSERT … ON CONFLICT DO
NOTHING` into an `idempotency` table *before* any work happens, so two simultaneous retries cannot
both proceed. The key stores a hash of `{slot_id, name, email}`: the same body replays the stored
`201` and the same booking `id`; a different body is `422`. A zero-effort retry that loses the claim
race waits briefly for the winner and replays its response. Replays are not counted against the rate
limit — a retry is not a new attempt.

Pagination uses keyset cursors over a monotonic `seq`, not offsets, so pages stay stable while
bookings are created: `WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`. The cursor is opaque
(base64url). Limit outside 1–50, or a non-integer, is `400`.

**Level 5 — spam.** Each booking attempt (successful **or** failed) is recorded against the lower-cased
email in `rate_events`. The sixth attempt inside a rolling 60-second window returns `429` with
`Retry-After` in whole seconds — the time until enough of that email's attempts leave the window.
Other emails are untouched. The `429` itself is not recorded, so a client that backs off gets a clean
window instead of a permanently sliding one.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:3000 with an in-process Postgres in .data/
API_BASE=http://localhost:3000 API_KEY=dev-only-key node scripts/seed.mjs
```

`API_KEY` defaults to `dev-only-key` when unset. With `DATABASE_URL` set, the same code talks to a
real Postgres instead of the local one — the SQL is identical either way.

## Tests

```bash
npm test
```

Starts the server on port 3999 against a throwaway database and runs 20 checks over real HTTP:
auth, every validation case, started/unknown slots, a **20-request simultaneous race** on one slot
(exactly one `201`, nineteen `409`), cancel-and-rebook, idempotent replay and `422`, three-page
cursor walk with no duplicates or gaps, `limit` bounds, `429` with a well-formed `Retry-After`, and
`/reset` clearing state.

## Notes

- The assessment API key is embedded in `public/config.js` so the demo page works out of the box.
  That is fine for a graded demo; a real deployment would keep the key server-side behind a proxy.
- Slot times are stored twice: the exact strings the caller sent (returned verbatim) and a parsed
  `timestamptz` used for ordering and the "already started" check.
- `/reset` also clears idempotency keys and rate-limit history, so a test run starts from a clean
  world.
