const BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY;

if (!KEY) {
  console.error('Set API_KEY (and API_BASE for a deployed host).');
  process.exit(1);
}

const slots = [];
const now = Date.now();

for (let day = 1; slots.length < 40 && day <= 21; day += 1) {
  const base = new Date(now + day * 86_400_000);
  if (base.getUTCDay() === 0) continue;

  for (const [hour, minute] of [[9, 0], [10, 30], [12, 0], [14, 30]]) {
    const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute);
    if (start <= now) continue;
    slots.push({
      id: `s${slots.length + 1}`,
      provider: slots.length % 2 === 0 ? 'Dr Ade' : 'Dr Bello',
      start: new Date(start).toISOString(),
      end: new Date(start + 30 * 60_000).toISOString(),
    });
  }
}

const res = await fetch(`${BASE}/reset`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': KEY },
  body: JSON.stringify({ slots }),
});

console.log(res.status, await res.text(), `(${slots.length} slots)`);
