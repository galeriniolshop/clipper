/** Shared HTTP helpers for the Vercel serverless functions. */

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-ollama-api-key');
  res.setHeader('Cache-Control', 'no-store');
}

/** Server-Sent Event frame. */
export function sse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

/** Pulls a user-supplied key out of header / body / query, in that order. */
export function extractKey(req, body) {
  const header = req.headers['x-ollama-api-key'] || req.headers['x-gemini-api-key'];
  if (header) return String(header).trim();
  const auth = req.headers.authorization;
  if (auth) return String(auth).replace(/^bearer\s+/i, '').trim();
  if (body && typeof body.api_key === 'string' && body.api_key.trim()) return body.api_key.trim();
  return '';
}
