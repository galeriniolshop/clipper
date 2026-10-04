/** GET /api/health — deployment + configuration diagnostics. */

import { cors } from './_lib/http.js';
import { hasServerKey, DEFAULT_MODEL } from './_lib/ollama.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const isVercel = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const supadataCount = (process.env.SUPADATA_API_KEYS || process.env.SUPADATA_API_KEY || '')
    .split(/[,\s\n]+/)
    .map((k) => k.trim())
    .filter(Boolean).length;

  return res.status(200).json({
    status: 'ok',
    message: 'CHEAT CLIP API is active (Ollama Cloud)',
    is_vercel: isVercel,
    provider: 'ollama-cloud',
    default_model: DEFAULT_MODEL,
    ollama_key_configured: hasServerKey(),

    // Transcript sourcing. InnerTube alone only works for a minority of videos
    // (YouTube answers "sign in to continue" for most popular uploads from a
    // datacenter IP), so a Supadata key is what makes this dependable.
    transcript: {
      innertube: true,
      supadata_keys: supadataCount,
      manual_upload: true,
      reliable: supadataCount > 0,
    },

    node: process.version,
    timestamp: new Date().toISOString(),
  });
}
