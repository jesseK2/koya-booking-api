import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = Number(process.env.TEST_PORT || 3999);
const KEY = 'test-key-123';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '.data/test-pg';

fs.rmSync(DATA_DIR, { recursive: true, force: true });

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), API_KEY: KEY, PGLITE_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(`  [server] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`  [server] ${chunk}`));

async function call(method, path, { body, key = KEY, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { 'x-api-key': key }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

function assert(cond, label) {
  if (!cond) throw new Error(label);
}
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const future = (minutes) => new Date(Date.UTC(2027, 0, 10, 9, 0) + minutes * 60_000).toISOString();

function demoSlots() {
  const slots = [];
  for (let i = 1; i <= 12; i += 1) {
    slots.push({
      id: `s${i}`,
      provider: i <= 6 ? 'Dr Ade' : 'Dr Bello',
      start: future((i - 1) * 30),
      end: future(i * 30),
    });
  }
  slots.push({ id: 'past1', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' });
  return slots;
}

const stamp = Date.now();
const email = (tag) => `${tag}-${stamp}@example.com`;

async function main() {
  // wait for the server
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/slots`, { headers: { 'x-api-key': KEY } });
      if (res.status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 250));
  }

  await test('reset replaces slots and returns 200', async () => {
    const res = await call('POST', '/reset', { body: { slots: demoSlots() } });
    equal(res.status, 200, 'status');
  });

  await test('level 1: list slots, earliest first, all available', async () => {
    const res = await call('GET', '/slots');
    equal(res.status, 200, 'status');
    assert(Array.isArray(res.body.slots), 'slots is an array');
    equal(res.body.slots.length, 13, 'slot count');
    const starts = res.body.slots.map((s) => Date.parse(s.start));
    equal(starts, [...starts].sort((a, b) => a - b), 'sorted by start');
    assert(res.body.slots.every((s) => s.available === true), 'all available');
    equal(Object.keys(res.body.slots[0]).sort(), ['available', 'end', 'id', 'provider', 'start'], 'slot shape');
  });

  await test('level 1: provider filter is an exact match', async () => {
    const res = await call('GET', '/slots?provider=Dr%20Bello');
    equal(res.status, 200, 'status');
    assert(res.body.slots.length === 6, 'six Bello slots');
    assert(res.body.slots.every((s) => s.provider === 'Dr Bello'), 'only Bello');
    const none = await call('GET', '/slots?provider=Nobody');
    equal(none.body.slots.length, 0, 'unknown provider empty');
  });

  let bookingId;
  await test('level 1: book a slot, then look it up', async () => {
    const res = await call('POST', '/bookings', {
      body: { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM ' },
    });
    equal(res.status, 201, 'status');
    bookingId = res.body.id;
    assert(typeof bookingId === 'string' && bookingId.length > 0, 'has id');
    equal(res.body.slot_id, 's1', 'slot_id');
    equal(res.body.name, 'Ada Obi', 'name trimmed');
    equal(res.body.email, 'ada@example.com', 'email trimmed + lowercased');
    equal(res.body.status, 'confirmed', 'status');
    assert(!Number.isNaN(Date.parse(res.body.created_at)), 'created_at is a date');

    const lookup = await call('GET', `/bookings/${bookingId}`);
    equal(lookup.status, 200, 'lookup status');
    equal(lookup.body.id, bookingId, 'same id');
  });

  await test('level 1: a booked slot shows as unavailable', async () => {
    const res = await call('GET', '/slots');
    const slot = res.body.slots.find((s) => s.id === 's1');
    equal(slot.available, false, 's1 unavailable');
  });

  await test('level 1: unknown booking id is 404', async () => {
    const res = await call('GET', '/bookings/does-not-exist');
    equal(res.status, 404, 'status');
    assert(typeof res.body.error === 'string', 'error message');
  });

  await test('level 2: missing or wrong API key is 401', async () => {
    equal((await call('GET', '/slots', { key: null })).status, 401, 'missing key');
    equal((await call('GET', '/slots', { key: 'wrong' })).status, 401, 'wrong key');
    equal((await call('POST', '/bookings', { key: 'wrong', body: {} })).status, 401, 'wrong key on POST');
    equal((await call('POST', '/reset', { key: null, body: { slots: [] } })).status, 401, 'wrong key on reset');
  });

  await test('level 2: missing/invalid fields are 400', async () => {
    const cases = [
      ['missing slot_id', { name: 'A', email: email('val1') }],
      ['empty slot_id', { slot_id: '', name: 'A', email: email('val2') }],
      ['missing name', { slot_id: 's2', email: email('val3') }],
      ['blank name', { slot_id: 's2', name: '   ', email: email('val4') }],
      ['missing email', { slot_id: 's2', name: 'A' }],
      ['invalid email', { slot_id: 's2', name: 'A', email: 'not-an-email' }],
      ['invalid email without tld', { slot_id: 's2', name: 'A', email: 'a@b' }],
    ];
    for (const [label, body] of cases) {
      const res = await call('POST', '/bookings', { body });
      equal(res.status, 400, label);
    }
  });

  await test('level 2: unknown slot is 404, started slot is 400', async () => {
    equal((await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'A', email: email('nf') } })).status, 404, 'unknown slot');
    const started = await call('POST', '/bookings', { body: { slot_id: 'past1', name: 'A', email: email('past') } });
    equal(started.status, 400, 'started slot');
  });

  await test('level 2: malformed JSON is 400', async () => {
    const res = await call('POST', '/bookings', { body: '{ not json' });
    equal(res.status, 400, 'status');
  });

  await test('level 3: second booking for the same slot is 409', async () => {
    const first = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Ada', email: email('first') } });
    equal(first.status, 201, 'first');
    const second = await call('POST', '/bookings', { body: { slot_id: 's2', name: 'Ben', email: email('second') } });
    equal(second.status, 409, 'second');
    assert(typeof second.body.error === 'string', 'error message');
  });

  await test('level 3: 20 simultaneous bookings produce exactly one winner', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('POST', '/bookings', { body: { slot_id: 's3', name: `Racer ${i}`, email: email(`race${i}`) } }),
      ),
    );
    const created = attempts.filter((r) => r.status === 201);
    const conflicts = attempts.filter((r) => r.status === 409);
    equal(created.length, 1, 'exactly one 201');
    equal(conflicts.length, 19, 'nineteen 409');
    assert(attempts.every((r) => r.status === 201 || r.status === 409), 'no other statuses');

    const list = await call('GET', '/slots');
    equal(list.body.slots.find((s) => s.id === 's3').available, false, 's3 unavailable');
  });

  await test('level 3: cancel frees the slot and can be booked again', async () => {
    const created = await call('POST', '/bookings', { body: { slot_id: 's4', name: 'Ada', email: email('cancel-a') } });
    equal(created.status, 201, 'created');
    const cancelled = await call('DELETE', `/bookings/${created.body.id}`);
    equal(cancelled.status, 200, 'cancelled');
    equal(cancelled.body.status, 'cancelled', 'status field');

    const list = await call('GET', '/slots');
    equal(list.body.slots.find((s) => s.id === 's4').available, true, 'slot free again');

    const rebook = await call('POST', '/bookings', { body: { slot_id: 's4', name: 'Ben', email: email('cancel-b') } });
    equal(rebook.status, 201, 'rebooked');

    equal((await call('DELETE', `/bookings/${created.body.id}`)).status, 409, 'double cancel');
    equal((await call('DELETE', '/bookings/nope')).status, 404, 'unknown booking');
  });

  await test('level 4: same Idempotency-Key + body never duplicates', async () => {
    const who = email('idem');
    const body = { slot_id: 's5', name: 'Ada Obi', email: who };
    const first = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': `k-${stamp}` } });
    equal(first.status, 201, 'first');
    for (let i = 0; i < 3; i += 1) {
      const retry = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': `k-${stamp}` } });
      equal(retry.status, 201, `retry ${i} status`);
      equal(retry.body.id, first.body.id, `retry ${i} same id`);
    }
    const list = await call('GET', `/bookings?email=${who}`);
    equal(list.body.bookings.length, 1, 'only one booking exists');
  });

  await test('level 4: same key with a different body is 422', async () => {
    const res = await call('POST', '/bookings', {
      body: { slot_id: 's6', name: 'Ada Obi', email: email('idem2') },
      headers: { 'Idempotency-Key': `k-${stamp}` },
    });
    equal(res.status, 422, 'status');
  });

  await test('level 4: cursor pagination walks every booking in order', async () => {
    const who = email('pager');
    const created = [];
    for (const slot of ['s7', 's8', 's9', 's10', 's11']) {
      const res = await call('POST', '/bookings', { body: { slot_id: slot, name: 'Pager', email: who } });
      equal(res.status, 201, `book ${slot}`);
      created.push(res.body.id);
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const url = `/bookings?email=${encodeURIComponent(who)}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await call('GET', url);
      equal(res.status, 200, 'page status');
      assert(res.body.bookings.length <= 2, 'page size respected');
      seen.push(...res.body.bookings.map((b) => b.id));
      cursor = res.body.next_cursor;
      pages += 1;
    } while (cursor);

    equal(pages, 3, 'three pages');
    equal(seen, created, 'oldest first, no duplicates, nothing missing');

    const upper = await call('GET', `/bookings?email=${encodeURIComponent(who.toUpperCase())}`);
    equal(upper.body.bookings.length, 5, 'email match ignores case');
    equal(upper.body.next_cursor, null, 'last page cursor null');
  });

  await test('level 4: invalid limit or email is 400', async () => {
    const who = encodeURIComponent(email('pager'));
    equal((await call('GET', `/bookings?email=${who}&limit=0`)).status, 400, 'limit 0');
    equal((await call('GET', `/bookings?email=${who}&limit=51`)).status, 400, 'limit 51');
    equal((await call('GET', `/bookings?email=${who}&limit=abc`)).status, 400, 'limit abc');
    equal((await call('GET', '/bookings')).status, 400, 'missing email');
    equal((await call('GET', `/bookings?email=${who}&limit=50`)).status, 200, 'limit 50 allowed');
  });

  await test('level 5: the sixth attempt in a minute is 429 with Retry-After', async () => {
    const who = email('spam');
    for (let i = 0; i < 5; i += 1) {
      const res = await call('POST', '/bookings', {
        body: { slot_id: 'missing-slot', name: 'Spam', email: who },
      });
      equal(res.status, 404, `attempt ${i + 1} still processed`);
    }
    const blocked = await call('POST', '/bookings', { body: { slot_id: 's6', name: 'Spam', email: who } });
    equal(blocked.status, 429, 'sixth attempt blocked');
    const retryAfter = blocked.headers.get('retry-after');
    assert(retryAfter && /^\d+$/.test(retryAfter), 'Retry-After is whole seconds');
    assert(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, 'Retry-After in range');
  });

  await test('level 5: other emails are unaffected', async () => {
    const res = await call('POST', '/bookings', { body: { slot_id: 's6', name: 'Quiet', email: email('quiet') } });
    equal(res.status, 201, 'different email books fine');
  });

  await test('level 1: reset wipes bookings and replaces slots', async () => {
    const res = await call('POST', '/reset', { body: { slots: demoSlots().slice(0, 2) } });
    equal(res.status, 200, 'status');
    const list = await call('GET', '/slots');
    equal(list.body.slots.length, 2, 'two slots');
    assert(list.body.slots.every((s) => s.available), 'no bookings remain');
    equal((await call('GET', `/bookings/${bookingId}`)).status, 404, 'old booking gone');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('\nfatal:', err.message);
  code = 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
process.exit(code);
