/**
 * Local dev server that mirrors the Vercel runtime:
 *   - serves the built frontend from dist/
 *   - routes /api/* to the serverless handlers
 *   - falls back to index.html for SPA routes
 *
 * `vercel dev` needs a Vercel login, so this keeps local development working
 * without an account. Production still deploys to Vercel itself.
 *
 * Usage: npm run dev:local
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Adapts a Vercel (req, res) handler onto node:http. */
async function runHandler(incoming, res, url, body) {
  const name = url.pathname.replace(/^\/api\/?/, '').replace(/\.js$/, '') || 'index';
  const candidates = [join(ROOT, 'api', `${name}.js`), join(ROOT, 'api', name, 'index.js')];
  let mod = null;
  for (const path of candidates) {
    try {
      if (await stat(path)) {
        mod = await import(pathToFileURL(path).href);
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (!mod?.default) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `No handler for ${url.pathname}` }));
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const originalWriteHead = res.writeHead.bind(res);
  const headers = Object.fromEntries(
    Object.entries(incoming.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v])
  );
  const req = {
    method: body ? 'POST' : 'GET',
    url: url.pathname,
    query,
    headers,
    body,
  };

  const chunks = [];
  let statusCode = null;
  let sent = false;
  const pendingHeaders = {};
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const flushHead = () => {
    if (sent || res.headersSent) return;
    sent = true;
    originalWriteHead(statusCode || 200, pendingHeaders);
  };

  // Vercel hands the handler an Express-like response. Re-create just enough of
  // that surface on top of node:http. Writes are buffered and flushed at the end
  // so an SSE handler that calls writeHead() itself still ends up with exactly
  // one header send.
  res.status = (code) => {
    statusCode = code;
    return res;
  };
  res.setHeader = (k, v) => {
    pendingHeaders[k] = v;
    return res;
  };
  res.getHeader = (k) => pendingHeaders[k.toLowerCase()];
  res.json = (obj) => {
    statusCode = statusCode || 200;
    pendingHeaders['Content-Type'] = 'application/json; charset=utf-8';
    flushHead();
    return originalEnd(JSON.stringify(obj));
  };
  res.send = (payload) => {
    flushHead();
    return originalEnd(payload);
  };
  res.writeHead = (code, headers = {}) => {
    statusCode = code;
    for (const [k, v] of Object.entries(headers)) pendingHeaders[k] = v;
    flushHead();
    return res;
  };
  res.write = (chunk) => {
    // Before the header send we must buffer (status/headers may still change).
    // After it, pass straight through so SSE frames reach the client live.
    if (sent || res.headersSent) return originalWrite(chunk);
    chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (payload) => {
    if (!sent && !res.headersSent) {
      flushHead();
      if (payload) chunks.push(Buffer.from(payload));
      if (chunks.length) originalWrite(Buffer.concat(chunks));
    } else if (payload) {
      originalWrite(payload);
    }
    return originalEnd();
  };

  await mod.default(req, res);
  return res.end();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      let body;
      if (req.method === 'POST' || req.method === 'PUT') {
        const buf = [];
        for await (const c of req) buf.push(c);
        const raw = Buffer.concat(buf).toString('utf8');
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
        }
      }
      return await runHandler(req, res, url, body);
    }

    // Static assets, then SPA fallback.
    const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(DIST, safe);
    if (file.startsWith(DIST)) {
      try {
        const info = await stat(file);
        if (info.isFile()) {
          const data = await readFile(file);
          res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
          return res.end(data);
        }
      } catch {
        /* fall through to index.html */
      }
    }

    const html = await readFile(join(DIST, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    return res.end(html);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('Internal error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Cheat Clip (Ollama Cloud) running`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
