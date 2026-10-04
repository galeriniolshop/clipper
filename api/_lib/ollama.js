/**
 * Ollama Cloud client — OpenAI-compatible endpoint.
 *
 *   POST https://ollama.com/v1/chat/completions
 *   Authorization: Bearer <OLLAMA_API_KEY>
 *
 * Zero dependencies: uses the native fetch available in Node 20 (Vercel runtime).
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'https://ollama.com';
const OPENAI_BASE = `${OLLAMA_BASE}/v1`;

/**
 * Default key baked in so the app works immediately after deploy.
 * Override at any time with the OLLAMA_API_KEY environment variable
 * (Vercel → Settings → Environment Variables).
 */
const BAKED_IN_KEY = '236cada1862b41769e2ea7b28ffcc7e6.NzFcxyOh3Zmjg1IUOg4NCm5m';

export function getApiKey(override) {
  return (override || process.env.OLLAMA_API_KEY || BAKED_IN_KEY || '').trim();
}

/** True when the caller typed a real key into the UI (overrides the server default). */
export function hasServerKey() {
  return Boolean((process.env.OLLAMA_API_KEY || BAKED_IN_KEY || '').trim());
}

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

export class OllamaError extends Error {
  constructor(message, { status = 502, code = 'ollama_error' } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Models this key cannot actually use, remembered for the life of the warm
 * lambda instance.
 *
 * Ollama Cloud answers HTTP 402 ("not included in your free usage") for models
 * outside the account's plan. Without this cache every request would waste a
 * full round trip rediscovering that, and oversized models can burn the whole
 * function budget before they ever time out.
 *
 * Entries expire so a plan upgrade takes effect without a cold start.
 */
const UNUSABLE_TTL_MS = 10 * 60 * 1000;
const unusableModels = new Map(); // model -> timestamp

export function markUnusable(model) {
  unusableModels.set(model, Date.now());
}

export function isUnusable(model) {
  const at = unusableModels.get(model);
  if (!at) return false;
  if (Date.now() - at > UNUSABLE_TTL_MS) {
    unusableModels.delete(model);
    return false;
  }
  return true;
}

export function unusableList() {
  return [...unusableModels.keys()];
}

/**
 * Lists every cloud model the key can reach.
 * Uses /api/tags (native) and falls back to /v1/models.
 */
export async function listModels(apiKey, { timeoutMs = 20000 } = {}) {
  const key = getApiKey(apiKey);
  if (!key) throw new OllamaError('Ollama API key is not configured.', { status: 500 });

  const attempts = [
    { url: `${OLLAMA_BASE}/api/tags`, pick: (j) => (j?.models || []).map((m) => m.name || m.model) },
    { url: `${OPENAI_BASE}/models`, pick: (j) => (j?.data || []).map((m) => m.id) },
  ];

  let lastErr;
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        headers: authHeaders(key),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new OllamaError(`Model list failed (HTTP ${res.status})`, { status: 502 });
      const names = attempt.pick(await res.json()).filter(Boolean);
      if (names.length) return names;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new OllamaError('Could not list Ollama Cloud models.');
}

/**
 * Default model.
 *
 * Chosen by benchmarking every free-tier model on this key against a real
 * transcript task (see README). gpt-oss:120b was both the fastest (~16s) and
 * the only one that copied transcript timestamps verbatim.
 */
export const DEFAULT_MODEL = 'gpt-oss:120b';

/**
 * Models measured to work well on this workload, best first.
 * Anything outside this list is still usable — the chain is intersected with
 * whatever the key can actually reach.
 */
export const PREFERRED_MODELS = [
  'gpt-oss:120b',
  'nemotron-3-super',
  'gpt-oss:20b',
  'nemotron-3-nano:30b',
];

/**
 * Ordered fallback chain.
 *
 * When the live model list is available we intersect it with PREFERRED_MODELS
 * so we never spend a round trip on a model the key cannot reach. When it is
 * not, we fall back to the preference order as-is.
 */
export function fallbackChain(requested, available = null) {
  const pool = [];
  if (available && available.length) {
    const set = new Set(available);
    for (const m of [requested, ...PREFERRED_MODELS]) {
      if (m && set.has(m) && !pool.includes(m)) pool.push(m);
    }
    if (!pool.length) pool.push(available[0]);
  } else {
    for (const m of [requested, ...PREFERRED_MODELS]) {
      if (m && !pool.includes(m)) pool.push(m);
    }
  }
  return pool;
}

/** Strips the <think>…</think> block that reasoning models emit alongside content. */
function stripReasoning(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Extracts the first balanced JSON object/array out of a model response. */
export function extractJson(text) {
  const clean = stripReasoning(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(clean);
  } catch {
    /* fall through to brace scanning */
  }
  const start = clean.search(/[{[]/);
  if (start === -1) return null;
  const open = clean[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(clean.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const isRetryable = (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

/**
 * Calls a cloud model and returns the raw assistant text.
 * `format: 'json'` pins the model to the Ollama JSON-mode grammar, which keeps
 * non-reasoning models from wrapping the payload in prose.
 */
export async function chat({
  model,
  messages,
  apiKey,
  temperature = 0.2,
  timeoutMs = 120000,
  maxRetries = 2,
  json = true,
}) {
  const key = getApiKey(apiKey);
  if (!key) throw new OllamaError('Ollama API key is not configured.', { status: 500 });

  const body = { model, messages, stream: false, temperature };
  if (json) body.format = 'json';

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        // 402 = the key's plan does not cover this model. Retrying is pointless.
        if (res.status === 402) {
          markUnusable(model);
          throw new OllamaError(`${model} is not covered by this Ollama Cloud plan (HTTP 402).`, {
            status: 402,
            code: 'model_not_in_plan',
          });
        }
        const err = new OllamaError(`${model} returned HTTP ${res.status}: ${detail}`, {
          status: isRetryable(res.status) ? 503 : 502,
          code: 'model_error',
        });
        if (!isRetryable(res.status)) throw err;
        lastErr = err;
        continue;
      }

      const json_out = await res.json();
      const text = json_out?.choices?.[0]?.message?.content ?? '';
      if (!text || !text.trim()) {
        lastErr = new OllamaError(`${model} returned an empty response.`, { status: 502 });
        continue;
      }
      return { text: stripReasoning(text) || text, raw: json_out };
    } catch (err) {
      // A model that blows the whole time budget is not worth revisiting.
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        markUnusable(model);
        throw new OllamaError(`${model} timed out after ${Math.round(timeoutMs / 1000)}s.`, {
          status: 504,
          code: 'model_timeout',
        });
      }
      if (err instanceof OllamaError && !isRetryable(err.status)) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof OllamaError
    ? lastErr
    : new OllamaError(lastErr?.message || 'Ollama request failed.', { status: 502 });
}
