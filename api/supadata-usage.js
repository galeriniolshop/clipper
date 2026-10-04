/**
 * GET /api/supadata-usage
 *
 * Supadata is the primary transcript source for this app (YouTube blocks
 * anonymous serverless access for the vast majority of videos), so its quota is
 * worth showing — the reference deployment runs ~19 rotating keys and lives or
 * dies by this number.
 *
 * Checks every configured key against GET /v1/me in parallel, with a short cache
 * so opening the page does not fire 19 upstream calls every time.
 */

import { cors } from './_lib/http.js';

export const config = { maxDuration: 30 };

const CACHE_MS = 30_000;
const CACHE = new Map(); // masked key -> usage snapshot
let cachedAt = 0;

const DEFAULTS = { max_credits: 100, used_credits: 0, plan: 'Free (100/mo)' };

function supadataKeys() {
  const raw = process.env.SUPADATA_API_KEYS || process.env.SUPADATA_API_KEY || '';
  return raw
    .split(/[,\s\n]+/)
    .map((k) => k.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

const mask = (k) => (k.length >= 11 ? `${k.slice(0, 7)}...${k.slice(-4)}` : '***');

/** Never log or return anything that could reconstruct a key. */
async function checkKey(key, index) {
  const base = { index, masked_key: mask(key), ...DEFAULTS, status: 'error', remaining_credits: 0 };
  try {
    const res = await fetch('https://api.supadata.ai/v1/me', {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) {
      const d = await res.json();
      const max = Number(d.maxCredits ?? 100);
      const used = Number(d.usedCredits ?? 0);
      const remaining = Math.max(0, max - used);
      return {
        ...base,
        max_credits: max,
        used_credits: used,
        remaining_credits: remaining,
        plan: d.plan || 'Free (100/mo)',
        status: remaining === 0 ? 'exhausted' : 'active',
      };
    }
    if (res.status === 429 || res.status === 402) {
      return { ...base, used_credits: base.max_credits, status: 'exhausted', plan: 'Limit Exceeded' };
    }
    return { ...base, plan: `HTTP ${res.status}`, remaining_credits: 0 };
  } catch {
    return { ...base, plan: 'Timeout/Error' };
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const keys = supadataKeys();
  if (!keys.length) {
    return res.status(200).json({
      total_keys: 0,
      total_limit: 0,
      total_used: 0,
      total_remaining: 0,
      usage_percent: 0,
      active_keys: 0,
      exhausted_keys: 0,
      keys_detail: [],
      status: 'not_configured',
    });
  }

  const fresh = Date.now() - cachedAt < CACHE_MS;
  const results = await Promise.all(
    keys.map(async (key, i) => {
      const id = mask(key);
      if (fresh && CACHE.has(id)) return CACHE.get(id);
      const info = await checkKey(key, i + 1);
      CACHE.set(id, info);
      return info;
    })
  );
  cachedAt = Date.now();

  const total_limit = results.reduce((a, k) => a + k.max_credits, 0);
  const total_used = results.reduce((a, k) => a + k.used_credits, 0);
  const total_remaining = results.reduce((a, k) => a + k.remaining_credits, 0);
  const exhausted = results.filter((k) => k.status === 'exhausted').length;

  return res.status(200).json({
    total_keys: results.length,
    total_limit,
    total_used,
    total_remaining,
    usage_percent: total_limit ? Number(((total_used / total_limit) * 100).toFixed(1)) : 0,
    active_keys: results.length - exhausted,
    exhausted_keys: exhausted,
    keys_detail: results,
    status: exhausted === results.length ? 'exhausted' : 'ok',
  });
}
