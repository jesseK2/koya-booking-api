import crypto from 'node:crypto';
import { query } from './db.js';

const API_KEY = process.env.API_KEY || 'dev-only-key';
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-API-Key, Idempotency-Key',
  'access-control-max-age': '86400',
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const fail = (status, message, headers) => {
  throw new HttpError(status, message, headers);
};

function reply(status, body, headers = {}) {
  return { status, headers: { ...CORS, ...headers }, body };
}

/* ------------------------------------------------------------------ helpers */

function requireApiKey(headers) {
  const given = headers['x-api-key'];
  if (typeof given !== 'string' || given.length === 0) {
    fail(401, 'missing X-API-Key header');
  }
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) fail(401, 'invalid API key');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function serializeBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function encodeCursor(seq) {
  return Buffer.from(`seq:${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  let raw;
  try {
    raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
  } catch {
    fail(400, 'invalid cursor');
  }
  const match = /^seq:(\d+)$/.exec(raw);
  if (!match) fail(400, 'invalid cursor');
  return Number(match[1]);
}

function parseBody(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(400, 'request body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    fail(400, 'request body must be valid JSON');
  }
}

/* -------------------------------------------------------------- rate limits */

async function checkRateLimit(email) {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM rate_events
      WHERE email = $1 AND at > now() - make_interval(secs => $2)`,
    [email, RATE_LIMIT_WINDOW_SECONDS],
  );
  const used = rows[0].n;
  if (used < RATE_LIMIT_MAX) return;

  // The attempt that has to fall out of the window before this email may try again.
  const { rows: oldest } = await query(
    `SELECT at
       FROM rate_events
      WHERE email = $1 AND at > now() - make_interval(secs => $2)
      ORDER BY at ASC, id ASC
      OFFSET $3 LIMIT 1`,
    [email, RATE_LIMIT_WINDOW_SECONDS, used - RATE_LIMIT_MAX],
  );
  const at = oldest[0]?.at ? new Date(oldest[0].at).getTime() : Date.now();
  const seconds = Math.max(
    1,
    Math.ceil((at + RATE_LIMIT_WINDOW_SECONDS * 1000 - Date.now()) / 1000),
  );
  fail(429, 'too many booking attempts for this email', { 'retry-after': String(seconds) });
}

async function recordAttempt(email) {
  await query(`INSERT INTO rate_events (email) VALUES ($1)`, [email]);
  await query(
    `DELETE FROM rate_events WHERE email = $1 AND at < now() - interval '10 minutes'`,
    [email],
  );
}

/* ------------------------------------------------------------- idempotency */

async function loadIdempotency(key) {
  const { rows } = await query(
    `SELECT key, body_hash, status_code, response FROM idempotency WHERE key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

async function claimIdempotency(key, bodyHash) {
  const { rows } = await query(
    `INSERT INTO idempotency (key, body_hash) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, bodyHash],
  );
  return rows.length === 1;
}

async function saveIdempotency(key, body) {
  await query(
    `UPDATE idempotency SET status_code = $2, response = $3::jsonb WHERE key = $1`,
    [key, 201, JSON.stringify(body)],
  );
}

async function clearIdempotency(key) {
  await query(`DELETE FROM idempotency WHERE key = $1`, [key]);
}

async function waitForIdempotency(key, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await loadIdempotency(key);
    if (!row) return null;
    if (row.status_code) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return loadIdempotency(key);
}

/* ------------------------------------------------------------------- routes */

async function resetSlots(body) {
  const slots = body.slots;
  if (!Array.isArray(slots)) fail(400, 'slots must be an array');

  const rows = slots.map((slot, index) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      fail(400, `slots[${index}] must be an object`);
    }
    const { id, provider, start, end } = slot;
    if (typeof id !== 'string' || id.trim() === '') fail(400, `slots[${index}].id is required`);
    if (typeof provider !== 'string') fail(400, `slots[${index}].provider is required`);
    if (typeof start !== 'string' || typeof end !== 'string') {
      fail(400, `slots[${index}].start and .end must be ISO date-time strings`);
    }
    const parsed = Date.parse(start);
    // Slots in the past are allowed by /reset; keep them sortable regardless.
    const startAt = Number.isNaN(parsed) ? new Date('9999-12-31T00:00:00Z') : new Date(parsed);
    return { id: id.trim(), provider, start, end, startAt };
  });

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) fail(400, `duplicate slot id ${row.id}`);
    seen.add(row.id);
  }

  await query(`TRUNCATE TABLE bookings, idempotency, rate_events RESTART IDENTITY`);
  await query(`DELETE FROM slots`);
  for (const row of rows) {
    await query(
      `INSERT INTO slots (id, provider, start_raw, end_raw, start_at) VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.provider, row.start, row.end, row.startAt.toISOString()],
    );
  }

  return reply(200, { ok: true, slots: rows.length });
}

async function listSlots(search) {
  const provider = search.get('provider');
  const params = [];
  let where = '';
  if (provider !== null) {
    params.push(provider);
    where = `WHERE s.provider = $1`;
  }
  const { rows } = await query(
    `SELECT s.id,
            s.provider,
            s.start_raw AS start,
            s.end_raw   AS end,
            NOT EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.slot_id = s.id AND b.status = 'confirmed'
            ) AS available
       FROM slots s
       ${where}
      ORDER BY s.start_at ASC, s.id ASC`,
    params,
  );
  return reply(200, { slots: rows });
}

async function bookSlot(headers, raw) {
  const body = parseBody(raw);
  const idempotencyKey = (headers['idempotency-key'] || '').trim();
  const bodyHash = sha256(
    JSON.stringify({
      slot_id: body.slot_id ?? null,
      name: body.name ?? null,
      email: body.email ?? null,
    }),
  );

  if (idempotencyKey) {
    const existing = await loadIdempotency(idempotencyKey);
    if (existing) {
      if (existing.body_hash !== bodyHash) {
        fail(422, 'Idempotency-Key was already used with a different request body');
      }
      if (existing.status_code) {
        return reply(existing.status_code, existing.response);
      }
      const settled = await waitForIdempotency(idempotencyKey);
      if (settled?.status_code) return reply(settled.status_code, settled.response);
      fail(409, 'a request with this Idempotency-Key is still in progress');
    }
    if (!(await claimIdempotency(idempotencyKey, bodyHash))) {
      const raced = await waitForIdempotency(idempotencyKey);
      if (raced?.body_hash && raced.body_hash !== bodyHash) {
        fail(422, 'Idempotency-Key was already used with a different request body');
      }
      if (raced?.status_code) return reply(raced.status_code, raced.response);
      fail(409, 'a request with this Idempotency-Key is still in progress');
    }
  }

  try {
    const result = await createBooking(body);
    if (idempotencyKey && result.status === 201) {
      await saveIdempotency(idempotencyKey, result.body);
    } else if (idempotencyKey) {
      await clearIdempotency(idempotencyKey);
    }
    return result;
  } catch (err) {
    if (idempotencyKey) await clearIdempotency(idempotencyKey).catch(() => {});
    throw err;
  }
}

async function createBooking(body) {
  const rawSlotId = body.slot_id;
  const rawName = body.name;
  const rawEmail = body.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

  if (email) {
    await checkRateLimit(email);
    await recordAttempt(email);
  }

  if (typeof rawSlotId !== 'string' || rawSlotId.trim() === '') {
    fail(400, 'slot_id is required');
  }
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    fail(400, 'name is required');
  }
  if (typeof rawEmail !== 'string' || rawEmail.trim() === '') {
    fail(400, 'email is required');
  }
  if (!EMAIL_RE.test(email)) {
    fail(400, 'email is not valid');
  }

  const slotId = rawSlotId;
  const name = rawName.trim();

  const { rows: slotRows } = await query(
    `SELECT id, start_raw FROM slots WHERE id = $1`,
    [slotId],
  );
  const slot = slotRows[0];
  if (!slot) fail(404, 'slot not found');

  const startMs = Date.parse(slot.start_raw);
  if (!Number.isNaN(startMs) && startMs <= Date.now()) {
    fail(400, 'slot has already started');
  }

  const { rows } = await query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING id, slot_id, name, email, status, created_at`,
    [`bk_${crypto.randomUUID()}`, slotId, name, email],
  );
  if (rows.length === 0) fail(409, 'slot is already booked');

  return reply(201, serializeBooking(rows[0]));
}

async function getBooking(id) {
  const { rows } = await query(
    `SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) fail(404, 'booking not found');
  return reply(200, serializeBooking(rows[0]));
}

async function cancelBooking(id) {
  const { rows } = await query(
    `UPDATE bookings
        SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND status = 'confirmed'
      RETURNING id, slot_id, name, email, status, created_at`,
    [id],
  );
  if (rows.length === 0) {
    const { rows: existing } = await query(`SELECT status FROM bookings WHERE id = $1`, [id]);
    if (existing.length === 0) fail(404, 'booking not found');
    fail(409, 'booking is already cancelled');
  }
  return reply(200, serializeBooking(rows[0]));
}

async function listBookings(search) {
  const emailParam = search.get('email');
  if (emailParam === null || emailParam.trim() === '') fail(400, 'email is required');
  const email = emailParam.trim().toLowerCase();

  const limitParam = search.get('limit');
  let limit = 10;
  if (limitParam !== null && limitParam !== '') {
    if (!/^\d+$/.test(limitParam)) fail(400, 'limit must be an integer between 1 and 50');
    limit = Number(limitParam);
    if (limit < 1 || limit > 50) fail(400, 'limit must be an integer between 1 and 50');
  }

  const cursorParam = search.get('cursor');
  const after = cursorParam ? decodeCursor(cursorParam) : 0;

  const { rows } = await query(
    `SELECT id, slot_id, name, email, status, created_at, seq
       FROM bookings
      WHERE email = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [email, after, limit + 1],
  );

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
  return reply(200, { bookings: page.map(serializeBooking), next_cursor: nextCursor });
}

/* ------------------------------------------------------------------ router */

const ROUTES = [
  { method: 'POST', pattern: /^\/reset$/, handler: ({ raw }) => resetSlots(parseBody(raw)) },
  { method: 'GET', pattern: /^\/slots$/, handler: ({ search }) => listSlots(search) },
  { method: 'POST', pattern: /^\/bookings$/, handler: ({ headers, raw }) => bookSlot(headers, raw) },
  { method: 'GET', pattern: /^\/bookings$/, handler: ({ search }) => listBookings(search) },
  { method: 'GET', pattern: /^\/bookings\/([^/]+)$/, handler: ({ params }) => getBooking(decodeURIComponent(params[0])) },
  { method: 'DELETE', pattern: /^\/bookings\/([^/]+)$/, handler: ({ params }) => cancelBooking(decodeURIComponent(params[0])) },
  // Vercel rewrites /bookings/{id} here: this build only matches one path segment.
  { method: 'GET', pattern: /^\/booking$/, handler: ({ search }) => getBooking(requireId(search)) },
  { method: 'DELETE', pattern: /^\/booking$/, handler: ({ search }) => cancelBooking(requireId(search)) },
];

function requireId(search) {
  const id = search.get('id');
  if (!id) fail(400, 'booking id is required');
  return id;
}

export async function handle({ method, path, search, headers, raw }) {
  if (method === 'OPTIONS') {
    return { status: 204, headers: CORS, body: null };
  }

  try {
    requireApiKey(headers);

    const normalizedPath = path.length > 1 ? path.replace(/\/+$/, '') : path;
    const candidates = ROUTES.filter((route) => route.pattern.test(normalizedPath));
    if (candidates.length === 0) fail(404, 'not found');

    const route = candidates.find((entry) => entry.method === method);
    if (!route) {
      fail(405, 'method not allowed', { allow: candidates.map((entry) => entry.method).join(', ') });
    }

    const params = route.pattern.exec(normalizedPath).slice(1);
    return await route.handler({ params, search, headers, raw });
  } catch (err) {
    if (err instanceof HttpError) {
      return { status: err.status, headers: { ...CORS, ...err.headers }, body: { error: err.message } };
    }
    console.error('unhandled error', err);
    return { status: 500, headers: CORS, body: { error: 'internal server error' } };
  }
}
