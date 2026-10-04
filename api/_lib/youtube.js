/**
 * YouTube data layer — pure fetch, zero dependencies.
 *
 * Why InnerTube + ANDROID_VR?
 * ------------------------------------------------------------
 * Since 2025 YouTube's /api/timedtext endpoint requires a PO-token, and the
 * signed `captionTracks` baseUrl embedded in the watch-page HTML returns
 * HTTP 200 with an EMPTY body when requested from datacenter IPs (i.e. Vercel).
 *
 * The ANDROID_VR InnerTube client still returns a usable signed caption URL,
 * which means transcripts work from a serverless function with no proxy, no
 * Supadata key, and no yt-dlp binary.
 *
 * Same code path works locally and on Vercel.
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INNERTUBE_CLIENTS = [
  { clientName: 'ANDROID_VR', clientVersion: '1.60.19', androidSdkVersion: 32, deviceMake: 'Oculus', deviceModel: 'Quest 3' },
  { clientName: 'ANDROID_VR', clientVersion: '1.61.07', androidSdkVersion: 32, deviceMake: 'Oculus', deviceModel: 'Quest 3' },
  { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30 },
  { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone16,2' },
];

/**
 * Caption language preference.
 *
 * Indonesian is first on purpose — this tool is built and used in Indonesia,
 * and a native `id` track is much more accurate than machine-translating an
 * English one, which also keeps the AI's language matching correct.
 */
const LANG_PRIORITY = ['id', 'en', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'zh', 'zh-Hans', 'ar', 'hi', 'ru', 'nl', 'it'];

/** Pulls an 11-character YouTube video id out of any URL shape. */
export function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  let m = trimmed.match(/(?:v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.endsWith('youtu.be')) {
      const id = parsed.pathname.slice(1).split('/')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
  } catch {
    /* not a full URL */
  }
  return null;
}

const unescapeJson = (s) => JSON.parse(s.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16))));

/** InnerTube `player` call. Returns the parsed player response. */
async function innertubePlayer(videoId, timeoutMs = 20000, only = null) {
  let lastErr;
  for (const client of only ? [only] : INNERTUBE_CLIENTS) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': CHROME_UA,
          Origin: 'https://www.youtube.com',
          Referer: 'https://www.youtube.com/',
        },
        body: JSON.stringify({
          context: { client: { hl: 'en', gl: 'US', ...client } },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`InnerTube HTTP ${res.status}`);
      const data = await res.json();
      if (data?.error) throw new Error(data.error.message || 'InnerTube error');
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('InnerTube player request failed');
}

/** oEmbed title — cheap, reliable, and never bot-blocked. */
export async function fetchTitle(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.title) return data.title;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Video metadata: title, duration, live status.
 * Duration is a number of seconds, or 0 when YouTube withholds it.
 */
export async function fetchMetadata(videoId) {
  let player = null;
  try {
    player = await innertubePlayer(videoId);
  } catch {
    /* metadata degrades gracefully below */
  }

  const details = player?.videoDetails || {};
  const title = details.title || (await fetchTitle(videoId)) || `YouTube Video (${videoId})`;
  const duration = Number(details.lengthSeconds) || 0;
  const isLive =
    Boolean(details.isLiveContent) &&
    ['IS_LIVE', 'IS_UPCOMING', 'POST_LIVE_UPCOMING'].includes(player?.playabilityStatus?.status || '');

  return { videoId, title, duration, isLive, player };
}

/** Decodes YouTube's timedtext XML entities. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Parses timedtext format 3 (`<p t="ms" d="ms">text</p>`). */
function parseTimedtextXml(xml) {
  const out = [];
  const re = /<p\s+([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const t = Number((attrs.match(/\bt="(\d+)"/) || [])[1]);
    const d = Number((attrs.match(/\bd="(\d+)"/) || [])[1]);
    if (!Number.isFinite(t)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text, start: t / 1000, duration: Number.isFinite(d) && d > 0 ? d / 1000 : 2 });
  }
  return out;
}

/** Parses json3 (used when a track explicitly asks for it). */
function parseTimedtextJson3(raw) {
  const out = [];
  for (const ev of raw.events || []) {
    if (!Array.isArray(ev.segs)) continue;
    const text = decodeEntities(ev.segs.map((s) => s.utf8 || '').join('')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    out.push({ text, start, duration: (ev.dDurationMs || 2000) / 1000 });
  }
  return out;
}

/** Pulls caption track descriptors out of a player response. */
function extractTracks(player) {
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
    [];
  return (tracks || [])
    .filter((t) => t?.baseUrl)
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode || 'und',
      kind: t.kind || '',
      name: t.name?.simpleText || t.name?.runs?.[0]?.text || '',
    }));
}

/** Ranks tracks: manual captions beat auto-generated, then language preference. */
function orderTracks(tracks) {
  const score = (t) => {
    let s = 0;
    if (!t.kind) s += 100;
    const idx = LANG_PRIORITY.indexOf(t.languageCode);
    if (idx >= 0) s += 50 - idx;
    else if (t.languageCode.startsWith('en')) s += 20;
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a));
}

async function fetchTrack(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': CHROME_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.youtube.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`);
  const body = await res.text();
  if (!body.trim()) throw new Error('timedtext returned an empty body (blocked)');

  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      return parseTimedtextJson3(JSON.parse(trimmed));
    } catch {
      /* fall through to XML */
    }
  }
  if (trimmed.startsWith('WEBVTT')) {
    return parseWebVtt(trimmed);
  }
  return parseTimedtextXml(body);
}

/** Minimal WebVTT parser — covers the `fmt=vtt` case. */
function parseWebVtt(vtt) {
  const out = [];
  const toSec = (ts) => {
    const [h, m, rest] = ts.split(':');
    const [s, ms] = (rest || '0').split('.');
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${ms || 0}`);
  };
  const blocks = vtt.split(/\n\s*\n/);
  for (const block of blocks) {
    const line = block.split('\n').find((l) => l.includes('-->'));
    if (!line) continue;
    const [start, end] = line.split('-->').map((p) => p.trim().split(' ')[0]);
    const text = block
      .split('\n')
      .filter((l) => l.trim() && !l.includes('-->') && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!text) continue;
    const s = toSec(start);
    out.push({ text: decodeEntities(text), start: s, duration: Math.max(0.1, toSec(end) - s) });
  }
  return out;
}

/** Merges short caption fragments into sentence-like lines for better AI context. */
export function mergeIntoSentences(lines, { maxChars = 180, gap = 2 } = {}) {
  const out = [];
  let buf = null;
  for (const line of lines) {
    if (!buf) {
      buf = { ...line };
      continue;
    }
    const gapSec = line.start - (buf.start + buf.duration);
    const combined = `${buf.text} ${line.text}`.trim();
    const sentenceish = /[.!?…]["')\]]?\s*$/.test(buf.text);
    if (combined.length < maxChars && !sentenceish && gapSec <= gap) {
      buf.text = combined;
      buf.duration = line.start + line.duration - buf.start;
    } else {
      out.push(buf);
      buf = { ...line };
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Supadata fallback.
 *
 * YouTube increasingly answers anonymous InnerTube requests with
 * LOGIN_REQUIRED or UNPLAYABLE for popular videos — verified against real
 * uploads, where the WEB client fails for *every* video and ANDROID_VR only
 * covers a subset. When that happens a third-party transcript provider is the
 * only way to keep this working from a serverless function.
 *
 * Set SUPADATA_API_KEYS (comma-separated) to enable it.
 * https://supadata.ai offers 100 free requests/month per key.
 */
function supadataKeys() {
  const raw = process.env.SUPADATA_API_KEYS || process.env.SUPADATA_API_KEY || '';
  return raw
    .split(/[,\s\n]+/)
    .map((k) => k.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Keys known to be out of quota for this warm instance, so we stop wasting calls. */
const exhaustedKeys = new Map(); // key -> timestamp
const EXHAUSTED_TTL_MS = 60 * 60 * 1000;

function keyIsExhausted(key) {
  const at = exhaustedKeys.get(key);
  if (!at) return false;
  if (Date.now() - at > EXHAUSTED_TTL_MS) {
    exhaustedKeys.delete(key);
    return false;
  }
  return true;
}

async function fetchTranscriptSupadata(videoId) {
  const keys = supadataKeys();
  if (!keys.length) return { lines: [], errors: [] };

  const errors = [];
  for (const key of keys) {
    if (keyIsExhausted(key)) {
      errors.push('Supadata key skipped (quota exhausted earlier)');
      continue;
    }
    try {
      const res = await fetch(
        `https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}`,
        { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000) }
      );
      if (!res.ok) {
        // 402/429 mean the key is spent for this period.
        if (res.status === 402 || res.status === 429) exhaustedKeys.set(key, Date.now());
        errors.push(`Supadata HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const lines = (data?.content || [])
        .map((seg) => {
          const start = Number(seg.offset) / 1000;
          const duration = Number(seg.duration) / 1000;
          const text = String(seg.text || '').trim();
          return { text, start, duration, end: start + duration };
        })
        .filter((l) => l.text && Number.isFinite(l.start));
      if (lines.length) return { lines, errors };
      errors.push('Supadata returned no segments');
    } catch (err) {
      errors.push(`Supadata: ${err.message}`);
    }
  }
  return { lines: [], errors };
}

/**
 * Full transcript fetch.
 *
 * Order depends on what is available:
 *   - Supadata keys configured -> Supadata first (reliable, near-instant).
 *   - otherwise                -> YouTube InnerTube first (free, no key).
 *
 * The UI's manual .srt upload is the final, always-working fallback.
 */
export async function fetchTranscript(videoId, { maxLines = 6000 } = {}) {
  const errors = [];
  const supadataKeysConfigured = supadataKeys().length > 0;

  const trySupadata = async () => {
    const r = await fetchTranscriptSupadata(videoId);
    errors.push(...r.errors);
    return r.lines.length ? { lines: r.lines, source: 'supadata', language: 'auto' } : null;
  };

  const tryInnerTube = async () => {
    let player = null;
    try {
      player = await innertubePlayer(videoId);
    } catch (err) {
      errors.push(`InnerTube: ${err.message}`);
    }

    const status = player?.playabilityStatus?.status || '';
    if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE') {
      errors.push(`YouTube blocked anonymous access (${status})`);
    }

    for (const track of orderTracks(extractTracks(player))) {
      try {
        const lines = await fetchTrack(track.baseUrl);
        if (lines.length) return { lines, source: 'youtube', language: track.languageCode, blocked: false };
        errors.push(`timedtext(${track.languageCode}): empty`);
      } catch (err) {
        errors.push(`timedtext(${track.languageCode}${track.kind ? ',asr' : ''}): ${err.message}`);
      }
    }
    return { blocked: status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE' };
  };

  const order = supadataKeysConfigured ? [trySupadata, tryInnerTube] : [tryInnerTube, trySupadata];
  let blocked = false;

  for (const attempt of order) {
    const result = await attempt();
    if (result?.lines?.length) {
      return {
        lines: result.lines.slice(0, maxLines),
        source: result.source,
        language: result.language,
        blocked: false,
        errors,
      };
    }
    if (result?.blocked) blocked = true;
  }

  return { lines: [], source: 'none', errors, blocked };
}
