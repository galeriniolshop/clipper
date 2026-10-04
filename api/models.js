/**
 * GET/POST /api/models
 * Lists the Ollama Cloud models reachable with the active key.
 * Used by the model picker in the UI.
 */

import { cors, fail, extractKey } from './_lib/http.js';
import { listModels, DEFAULT_MODEL, fallbackChain, OllamaError } from './_lib/ollama.js';

export const config = { maxDuration: 60 };

// Shown when the key cannot be reached, so the picker is never empty.
const FALLBACK_MODELS = fallbackChain(DEFAULT_MODEL);

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'Use GET or POST.');

  const body = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
  const key = extractKey(req, body);

  if (key.toLowerCase() === 'mock') {
    return res.status(200).json({ models: ['mock'], source: 'mock' });
  }

  try {
    const models = await listModels(key);
    return res.status(200).json({
      models,
      default: models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0] || DEFAULT_MODEL,
      source: 'ollama-cloud',
    });
  } catch (err) {
    if (err instanceof OllamaError) {
      console.warn(`[cheat-clip] model list failed: ${err.message}`);
      return res.status(200).json({ models: FALLBACK_MODELS, default: FALLBACK_MODELS[0], source: 'fallback', warning: err.message });
    }
    console.error(`[cheat-clip] model list error: ${err?.stack || err}`);
    return res.status(200).json({ models: FALLBACK_MODELS, default: FALLBACK_MODELS[0], source: 'fallback', warning: 'Could not reach Ollama Cloud.' });
  }
}
