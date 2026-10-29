import { handle } from '../src/app.js';

async function readRaw(req) {
  if (req.body !== undefined) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  // Requested as /api/slots by a rewrite, or straight as /slots.
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';

  const search = url.searchParams;
  if ([...search.keys()].length === 0 && req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (key === 'path') continue;
      if (Array.isArray(value)) for (const item of value) search.append(key, item);
      else if (value !== undefined && value !== null) search.append(key, String(value));
    }
  }

  const out = await handle({
    method: req.method,
    path,
    search,
    headers: req.headers,
    raw: await readRaw(req),
  });

  res.statusCode = out.status;
  for (const [key, value] of Object.entries(out.headers)) res.setHeader(key, value);
  if (out.body === null) return res.end();
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(out.body));
}
