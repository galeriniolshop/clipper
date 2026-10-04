# 🎬 CHEAT CLIP — Vercel + Ollama Cloud

> **AI-Powered YouTube Viral Hotspot Finder**, rebuilt to run entirely on Vercel serverless functions with **Ollama Cloud** as the AI provider (no Google Gemini, no Python, no yt-dlp).

Paste a YouTube link → get back ranked, timestamped clip candidates with titles, captions and hashtags, ready to cut for Shorts / Reels / TikTok.

---

## What changed vs. the original

| | Original | This version |
|---|---|---|
| Backend | Python + FastAPI | **Node.js serverless functions** (`/api`) |
| AI provider | Google Gemini | **Ollama Cloud** |
| Dependencies | `yt-dlp`, `google-genai`, `youtube-transcript-api`, `fastapi`, … | **zero runtime dependencies** (native `fetch`) |
| Transcript | yt-dlp → youtube-transcript-api → Supadata | **InnerTube** → Supadata → manual `.srt` |
| API key | every user had to paste their own | **baked into the server**, user key optional |
| Runs on Vercel? | not reliably (heavy native deps, cold starts) | **yes, that's the target** |

The React UI is the original one, patched for Ollama Cloud. The response contract is unchanged, so the whole interface — heatmap timeline, copy-timestamps, player, bilingual EN/ID — works as before.

---

## ⚠️ Read this first: the transcript is the real constraint

Swapping Gemini for Ollama Cloud was the easy part. Fetching the **transcript** from a serverless function is the hard part, and it needs a real decision from you.

Measured on a live sandbox (datacenter IP), fetching YouTube captions anonymously:

| Method | Result |
|---|---|
| `captionTracks` from the watch-page HTML | HTTP 200, **empty body** — PO-token required |
| `/api/timedtext` (plain, signed, all formats) | **empty** |
| InnerTube `WEB` client (even with real `visitorData`) | `UNPLAYABLE` for **every** video |
| InnerTube `ANDROID_VR` client | ✅ works — but **`LOGIN_REQUIRED` for ~93% of videos** |
| `get_transcript` endpoint | HTTP 400 `Precondition check failed` |
| `ANDROID` / `IOS` clients | HTTP 400 (deprecated, need an API key) |

Success rate for anonymous InnerTube, tested across 15 videos spanning old/new, popular/rare, EN and otherwise: **1/15**.

So this build ships **three tiers**, in this order:

1. **Supadata** (used first when configured) — free tier is 100 requests/month, no credit card. This is the tier that makes the tool dependable.
2. **YouTube InnerTube** (`ANDROID_VR`) — free, no key, works for a minority of videos.
3. **Manual `.srt` / `.txt` upload** — already in the UI, always works.

> **To make this production-ready, get a free Supadata key** at <https://supadata.ai> and set `SUPADATA_API_KEYS` in Vercel. Multiple keys can be comma-separated; they are tried in order.

If you skip it, the app still deploys and runs — it just returns an actionable error for the videos YouTube walls off, and the upload-subtitles path keeps it usable.

### This matches what a real deployment does

The reference deployment at `johansa-cheat-clip.vercel.app` reports its own config on `/api/health`:

```json
{ "is_vercel": true, "proxy_configured": true, "gemini_env_configured": false,
  "supadata_keys_count": 19,
  "supadata": { "total_limit": 1900, "total_used": 1327, "total_remaining": 573,
                "active_keys": 6, "exhausted_keys": 13 } }
```

That confirms the design: a production instance runs on **~19 rotating Supadata keys** plus a residential proxy, and its upstream source lists Supadata as Tier 1. It also shows the real operational cost — 1327/1900 credits gone, **13 of 19 keys exhausted**. Which is why this build:

- renders Supadata quota in the UI via `/api/supadata-usage` (parallel `GET /v1/me` per key, 30s cache, keys only ever shown masked),
- **skips keys that return 402/429** for an hour instead of burning a request on each dead key,
- falls back to InnerTube only when Supadata has nothing.

The reference also prioritises captions in this order: `id, en, es, pt, fr, de, ja, ko, zh…`. This build does the same — **`id` first**, because a native Indonesian track beats a machine translation for accuracy and keeps the AI's language matching correct.

> If you need the residential-proxy tier too, put a Webshare or generic proxy URL in `PROXY_URL` / `WEBSHARE_PROXY` in the Vercel environment. It is not wired into this Node build (Node 20's `fetch` has no proxy support without an extra dependency), so treat it as a documented future option rather than something that works today.

---

## Deploy to Vercel

```bash
# 1. push to a Git repo and import it at vercel.com/new
#    (or: npx vercel --prod)

# 2. optional but recommended — Vercel → Settings → Environment Variables
OLLAMA_API_KEY=your_ollama_cloud_key
SUPADATA_API_KEYS=your_supadata_key

# 3. deploy
npm run build
```

Vercel auto-detects **Vite** for the frontend and the `/api` directory for the functions. No other configuration is needed.

Check the deployment:

```bash
curl https://your-app.vercel.app/api/health
```

```json
{
  "status": "ok",
  "provider": "ollama-cloud",
  "default_model": "gpt-oss:120b",
  "ollama_key_configured": true,
  "transcript": { "innertube": true, "supadata_keys": 1, "manual_upload": true, "reliable": true }
}
```

### Local development

```bash
npm install
npm run dev        # vercel dev — serves the UI and the API together
```

---

## 🔐 Security — please read before forking

A working Ollama Cloud key is **committed in `api/_lib/ollama.js`** (`BAKED_IN_KEY`) so the app runs the moment you deploy, which is what you asked for. It is only ever used **server-side** — it is never bundled into the browser JS, and `/api/health` only reports whether a key exists, never its value.

**If you fork this publicly, do one of these:**

- set `OLLAMA_API_KEY` in Vercel and delete `BAKED_IN_KEY` from `api/_lib/ollama.js`, **or**
- rotate the key at <https://ollama.com/settings/keys>.

Anyone who can read the repo can use that key against your quota, and a public deployment is an open relay. A Supadata key should live only in Vercel env vars, never in the repo.

---

## Model selection — benchmarked, not guessed

Six of the seventeen models on the key are included in free usage; the rest return **HTTP 402**. Each free model was benchmarked on the same real transcript task (12 clips, exact-timestamp compliance, latency):

| Model | Time | Clips | Exact timestamps | Verdict |
|---|---|---|---|---|
| **`gpt-oss:120b`** | **16.0s** | 10 | **10/10** | **default** — fastest and fully accurate |
| `nemotron-3-super` | 90.4s | 12 | 12/12 | good, but slow |
| `nemotron-3-nano:30b` | 118.4s | 10 | 10/10 | accurate, slowest usable |
| `gpt-oss:20b` | 59.8s | 12 | **0/12** | ignores timestamps — server-side snapping rescues it |
| `nemotron-3-ultra` | timeout | — | — | exceeds any sane function budget |
| `gemma4:31b` | timeout | — | — | exceeds any sane function budget |

`api/_lib/ollama.js` therefore ships `PREFERRED_MODELS` in that order, and `analyze` intersects it with the models your key can actually reach, so it never wastes a round trip on a 402. Models that 402 or time out are cached as unusable for 10 minutes.

---

## The heatmap is an estimate, and the AI is told so

The real "most watched" retention curve lives in a private engagement panel. It is **not** available through any anonymous endpoint (verified: the `/next` response contains only storyboard heatmaps, no `mostWatched`). The original project got it via `yt-dlp`, which cannot run on Vercel.

Rather than fabricate retention telemetry, `api/_lib/engagement.js` derives an interest curve from the transcript using signals that genuinely correlate with rewatch-worthy moments — curiosity gaps, emotional intensity, superlatives, speech density, and the classic cold-open decay. **The prompt tells the model this is an estimate, not retention telemetry**, so it is never presented to you as measured audience behaviour.

---

## Project layout

```
api/
  analyze.js          POST /api/analyze — SSE pipeline, Ollama Cloud call
  models.js           GET|POST /api/models — models your key can reach
  health.js           GET /api/health — diagnostics
  video-title.js      GET /api/video-title — oEmbed title
  supadata-usage.js   compat stub (upstream UI still asks for it)
  _lib/
    ollama.js         Ollama Cloud client, JSON mode, fallback chain, 402 cache
    youtube.js        InnerTube player, transcript tiers, SRT helpers
    engagement.js     estimated interest curve
    srt.js            SRT / VTT / timestamped-text parser
    http.js           CORS, SSE framing, key extraction
src/                  React UI (original, patched for Ollama Cloud)
test-api.mjs          32-check end-to-end suite against the real APIs
test-models.mjs       model benchmark used to pick the default
vercel.json           Vite build + function budgets + SPA rewrite
```

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/analyze` | SSE stream: metadata → transcript → interest curve → clips. Body: `{ url, duration, model, custom_prompt, range_start, range_end, target_clip_count, subtitles, api_key }` |
| `GET\|POST /api/models` | Models reachable with the active key |
| `GET /api/video-title?video_id=` | Real video title via oEmbed |
| `GET /api/health` | Deployment and transcript-source diagnostics |

Type `mock` in the API key field to explore the full UI with sample data and no API calls.

## Tests

```bash
node test-api.mjs
```

Runs the real pipeline against real YouTube and the real Ollama Cloud API: 32 assertions covering SSE framing, clip validation, overlap resolution, score ordering, first-person leakage in titles, and the manual-subtitle path.

---

## Credits

UI and core logic adapted from [galihjuansaputra/cheat-clip](https://github.com/galihjuansaputra/cheat-clip). Backend, transcript layer and AI integration rewritten for Ollama Cloud and Vercel serverless.
