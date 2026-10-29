import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { handle } from './app.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const API_PATH = /^\/(reset|slots|bookings)(\/|$)/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (API_PATH.test(url.pathname)) {
    const out = await handle({
      method: req.method,
      path: url.pathname,
      search: url.searchParams,
      headers: req.headers,
      raw: await readRaw(req),
    });
    res.writeHead(out.status, { ...out.headers, 'content-type': 'application/json; charset=utf-8' });
    return res.end(out.body === null ? '' : JSON.stringify(out.body));
  }

  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`booking app on http://localhost:${PORT}`);
});
