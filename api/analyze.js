/**
 * POST /api/analyze
 *
 * Streams progress as Server-Sent Events while it:
 *   1. reads YouTube metadata (InnerTube)
 *   2. fetches the transcript (InnerTube caption tracks, no proxy needed)
 *   3. derives an estimated interest curve
 *   4. asks an Ollama Cloud model for viral clip candidates (JSON mode)
 *
 * The response shape matches the upstream cheat-clip frontend exactly, so the
 * original React UI works against this backend unchanged.
 */

import { cors, sse, fail, extractKey } from './_lib/http.js';
import {
  extractVideoId,
  fetchMetadata,
  fetchTranscript,
  mergeIntoSentences,
} from './_lib/youtube.js';
import { parseManualSubtitles } from './_lib/srt.js';
import { buildEstimatedHeatmap, engagementAt } from './_lib/engagement.js';
import { chat, extractJson, fallbackChain, listModels, isUnusable, DEFAULT_MODEL, hasServerKey, OllamaError } from './_lib/ollama.js';

export const config = { maxDuration: 300 };

const DURATION_RANGE = { '15s': '10-20s', '30s': '20-40s', '60s': '45-75s' };

/** The model writes exactly this shape; the parser is strict about the numbers. */
const SYSTEM_PROMPT = `You are a senior short-form video editor who finds viral moments in long YouTube videos.
You always answer with a single valid JSON object and nothing else. No prose, no markdown fences, no commentary.

Schema:
{
  "summary": "string, 1-2 sentence video summary followed by 2-4 general hashtags",
  "clips": [
    {
      "title": "string, max 8 words, catchy, third person only",
      "start_time": number,
      "end_time": number,
      "hook_time": number,
      "virality_score": integer 1-100,
      "key_quotes": ["string"],
      "transcript": "string, the spoken text of the clip",
      "title_suggestion": "string, third person",
      "caption_suggestion": "string, one engaging social caption",
      "hashtag_suggestion": "string, 3-5 hashtags"
    }
  ]
}

Hard rules:
- Every start_time and end_time MUST be copied from the transcript timestamps you are given. Never invent or interpolate times.
- Clips must not overlap and must start and end on natural sentence boundaries.
- Never use first-person pronouns in title or title_suggestion: no "I", "me", "my", "mine", "saya", "aku", "gue". Frame around the speaker, their role, or the topic.
- Match your output language to the language of the transcript.`;

/**
 * Every transcript line carries the same shape everywhere downstream:
 *   { start, end, duration, text, engagement }
 */
function normaliseLines(raw) {
  return (raw || [])
    .map((l) => {
      const start = Number(l.start) || 0;
      const end = start + (Number(l.duration) || 0);
      return { start, end, duration: end - start, text: String(l.text || '').trim(), engagement: 0 };
    })
    .filter((l) => l.text && l.end > l.start);
}

function buildUserPrompt({ title, lines, heatmap, targetLength, clipRange, focus, startBound, endBound, duration }) {
  const hasHeatmap = heatmap && heatmap.length > 0;
  const dump = lines
    .map((l) => {
      const end = l.start + (l.duration || 0);
      const interest = Number.isFinite(l.engagement) ? l.engagement : 0;
      return `${l.start.toFixed(1)}|${end.toFixed(1)}|${interest.toFixed(2)} ${l.text}`;
    })
    .join('\n');

  const heatmapNote = hasHeatmap
    ? 'The third column (e.g. 0.42) is an ESTIMATED interest score derived from the dialogue, NOT real YouTube retention telemetry. Use it only as a weak tiebreaker.'
    : 'No interest signal is available. Judge purely on content: hooks, curiosity gaps, emotion, and story arc.';

  return `Find ${clipRange} viral short-form clip candidates (TikTok / Reels / Shorts) from this YouTube transcript.

Source video title: ${title}
Video length: ${Math.round(duration)}s
Search window: ${Math.round(startBound)}s to ${Math.round(endBound)}s
Target clip length: ${targetLength}

Transcript columns are: start|end|interest text
${heatmapNote}
${focus ? `\nCRITICAL FOCUS — the user specifically wants clips matching: "${focus}". Prioritise these while still keeping each clip standalone-worthy.\n` : ''}
TRANSCRIPT
---
${dump}
---

Return ${clipRange} clips sorted by virality_score descending, best first.`;
}

/** Coerces whatever the model returned into a clean, validated clip array. */
function normaliseClips(raw, lines, duration) {
  if (!Array.isArray(raw)) return [];

  const usable = lines.filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end));
  const maxStart = duration > 0 ? duration : Math.max(...usable.map((l) => l.end), 0);

  const snap = (value, candidates) => {
    if (!Number.isFinite(value)) return null;
    const best = candidates.reduce(
      (acc, c) => (Math.abs(c - value) < Math.abs(acc - value) ? c : acc),
      candidates[0]
    );
    return best;
  };

  const starts = usable.map((l) => l.start);
  const ends = usable.map((l) => l.end);

  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    let start = Number(c.start_time);
    let end = Number(c.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    start = Math.max(0, Math.min(start, maxStart));
    end = Math.max(start + 1, Math.min(end, maxStart));
    if (end <= start) continue;

    // Snap both edges onto real sentence boundaries when the model drifted.
    if (starts.length) {
      const snappedStart = snap(start, starts);
      const snappedEnd = snap(end, ends);
      if (snappedStart !== null && snappedEnd !== null && snappedEnd > snappedStart) {
        start = snappedStart;
        end = snappedEnd;
      }
    }

    const inWindow = usable.filter((l) => l.start >= start - 0.01 && l.end <= end + 0.01);
    const transcriptText = (inWindow.length ? inWindow : usable.filter((l) => l.start >= start && l.end <= end))
      .map((l) => l.text)
      .join(' ')
      .trim();

    const quotes = Array.isArray(c.key_quotes) ? c.key_quotes.filter((q) => typeof q === 'string' && q.trim()) : [];
    const score = Number(c.virality_score);

    let hook = Number(c.hook_time);
    if (!Number.isFinite(hook) || hook < start || hook > end) hook = start;

    out.push({
      title: String(c.title || 'Untitled Clip').trim().slice(0, 120),
      start_time: Number(start.toFixed(2)),
      end_time: Number(end.toFixed(2)),
      hook_time: Number(hook.toFixed(2)),
      virality_score: Number.isFinite(score) ? Math.max(1, Math.min(100, Math.round(score))) : 50,
      key_quotes: quotes.slice(0, 3),
      transcript: transcriptText || String(c.transcript || '').trim(),
      title_suggestion: String(c.title_suggestion || '').trim(),
      caption_suggestion: String(c.caption_suggestion || '').trim(),
      hashtag_suggestion: String(c.hashtag_suggestion || '')
        .replace(/#\w+/g, (m) => m.toLowerCase()),
    });
  }

  out.sort((a, b) => b.virality_score - a.virality_score);

  /**
   * Resolve overlaps without throwing clips away.
   *
   * Every model tends to return heavily overlapping ranges, so simply dropping
   * the conflicts throws away most of the output. Instead we keep the
   * higher-scoring clip whole and TRIM the conflicting one back to whichever
   * side still holds at least MIN_CLIP seconds of speech. Only genuinely
   * redundant clips (too short after trimming) are discarded.
   */
  const MIN_CLIP = 5;
  const kept = [];
  for (const clip of out) {
    let start = clip.start_time;
    let end = clip.end_time;

    for (const k of kept) {
      if (end <= k.start_time || start >= k.end_time) continue; // no conflict
      // Shrink on whichever side has more room.
      if (end - k.end_time >= k.start_time - start) {
        start = Math.max(start, k.end_time);
      } else {
        end = Math.min(end, k.start_time);
      }
    }

    if (end - start < MIN_CLIP) continue; // redundant once trimmed
    kept.push({ ...clip, start_time: Number(start.toFixed(2)), end_time: Number(end.toFixed(2)) });
  }
  return kept;
}

/** Keeps the model honest about the requested clip count. */
function trimToTarget(clips, target) {
  if (!target || clips.length <= target) return clips;
  return clips.slice(0, target);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');

  let body = {};
  if (typeof req.body === 'string') {
    try { body = JSON.parse(req.body || '{}'); } catch { body = {}; }
  } else if (req.body && typeof req.body === 'object') {
    body = req.body;
  }

  const userKey = extractKey(req, body);
  const isMock = userKey.toLowerCase() === 'mock';
  if (!userKey && !hasServerKey()) {
    return fail(res, 500, 'Ollama Cloud API key is not configured on the server.');
  }

  // ── SSE channel ──────────────────────────────────────────────────────────
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (data) => {
    try { res.write(sse(data)); } catch { /* client disconnected */ }
  };

  try {
    // ── Mock mode: sample data, no key needed ───────────────────────────────
    if (isMock) {
      const mockVideoId = extractVideoId(body.url) || 'dQw4w9WgXcQ';
      const lines = normaliseLines(
        mergeIntoSentences(
          [
            { text: 'Welcome back to the channel, today we break down exactly how this works.', start: 0, duration: 4 },
            { text: 'Most people think finding viral moments is guesswork.', start: 4, duration: 3.5 },
            { text: 'But there is a much smarter way to do it.', start: 7.5, duration: 3.5 },
            { text: 'You use the viewer retention curve that YouTube already tracks.', start: 11, duration: 4 },
            { text: 'And then an AI model scans the dialogue for hooks and punchlines.', start: 15, duration: 4.5 },
            { text: 'The result is that editors stop guessing and start shipping.', start: 19.5, duration: 4.5 },
            { text: 'If you want to grow on TikTok, this is the workflow to steal.', start: 24, duration: 5 },
          ],
          { maxChars: 999 }
        )
      );
      const heatmap = buildEstimatedHeatmap(lines, 30, { buckets: 30 });
      for (const stage of [
        ['Context Assembly', 'Aligning sample dialogue with interest data...', 30, 78],
        ['Viral Hook & Curiosity Detection', 'Scanning for hooks and punchlines...', 65, 88],
        ['Virality Scoring & Selection', 'Scoring clip candidates...', 92, 95],
      ]) {
        send({ step: 4, step_progress: stage[2], overall_progress: stage[3], stage: stage[0], detail: stage[1], message: `Mock AI (${stage[0]}): ${stage[1]}` });
        await new Promise((r) => setTimeout(r, 500));
      }
      const clips = normaliseClips(
        [
          { title: 'Finding hotspots using retention data', start_time: 11, end_time: 19.5, hook_time: 15, virality_score: 95, key_quotes: ['You use the viewer retention curve that YouTube already tracks.'], title_suggestion: 'How Retention Data Finds Viral Moments', caption_suggestion: 'Stop guessing what works. Here is how retention data finds your best clips. 🔥', hashtag_suggestion: '#viralclips #videoediting #retention #aitools' },
          { title: 'Grow on TikTok with this workflow', start_time: 19.5, end_time: 29, hook_time: 24, virality_score: 88, key_quotes: ['If you want to grow on TikTok, this is the workflow to steal.'], title_suggestion: 'The TikTok Workflow Editors Steal', caption_suggestion: 'Want to scale your TikTok views? Steal this workflow. 🚀', hashtag_suggestion: '#tiktokgrowth #reels #shorts #editingtips' },
          { title: 'Guesswork versus real data', start_time: 4, end_time: 11, hook_time: 7.5, virality_score: 74, key_quotes: ['Most people think finding viral moments is guesswork.'], title_suggestion: 'Why Guesswork Fails Video Editors', caption_suggestion: 'Most editors pick clips by vibes. Here is what actually works.', hashtag_suggestion: '#contentstrategy #creators #growth' },
        ],
        lines,
        30
      );
      send({
        step: 4, step_progress: 100, overall_progress: 100, stage: 'Analysis Complete',
        detail: 'Generated sample clip candidates.', done: true,
        result: { video_id: mockVideoId, title: 'Mock YouTube Video', duration: 30, heatmap, summary: 'Mock analysis of the sample transcript. #aitools #videoediting', clips, transcript: lines.map((l) => ({ start: l.start, end: l.end, text: l.text, engagement: 0.5 })), model: 'Mock (no API call)' },
      });
      return res.end();
    }

    // ── Step 1 — metadata ───────────────────────────────────────────────────
    send({ step: 1, step_progress: 30, overall_progress: 8, stage: 'Connecting to YouTube', detail: 'Fetching video metadata...', message: 'Connecting to YouTube — fetching title and duration...' });

    const videoId = extractVideoId(body.url);
    if (!videoId) {
      send({ error: 'Invalid YouTube URL. Paste a link like https://www.youtube.com/watch?v=XXXXXXXXXXX.', status: 400 });
      return res.end();
    }

    const meta = await fetchMetadata(videoId);
    let title = meta.title;
    let duration = meta.duration;
    send({ step: 1, step_progress: 100, overall_progress: 25, stage: 'Video Verified', detail: `Loaded "${title.slice(0, 45)}"${duration ? ` (${Math.round(duration)}s)` : ''}`, message: `Connected — "${title.slice(0, 45)}"` });

    // ── Step 2 — transcript ─────────────────────────────────────────────────
    send({ step: 2, step_progress: 40, overall_progress: 40, stage: 'Fetching Subtitles', detail: 'Requesting caption tracks from YouTube...', message: 'Fetching subtitles from YouTube...' });

    let lines = [];
    let transcriptSource = 'none';
    if (body.subtitles) {
      lines = parseManualSubtitles(body.subtitles, duration);
      transcriptSource = 'upload';
      if (!lines.length) {
        send({ error: 'Could not parse the uploaded subtitle file. Use SRT/VTT or lines prefixed with a timestamp.', status: 400 });
        return res.end();
      }
      send({ step: 2, step_progress: 100, overall_progress: 62, stage: 'Subtitles Ready', detail: `Parsed ${lines.length} lines from your uploaded file.`, message: `Uploaded subtitles parsed — ${lines.length} lines.` });
    } else {
      const result = await fetchTranscript(videoId);
      if (!result.lines.length) {
        let reason;
        if (meta.isLive) {
          reason = 'This video is live, upcoming, or still being processed, so YouTube has not published captions yet.';
        } else if (result.blocked) {
          reason =
            'YouTube refused anonymous access to this video (it answers "sign in to continue" for many popular uploads from a serverless IP).';
        } else {
          reason = 'This video has no captions available — they may be disabled, or the video is private or age-restricted.';
        }
        const supadataHint = process.env.SUPADATA_API_KEYS || process.env.SUPADATA_API_KEY
          ? ''
          : ' Add a free Supadata key as SUPADATA_API_KEYS on the server to cover these videos automatically.';
        send({
          error: `${reason} Upload a .srt or .txt subtitle file to analyze it anyway.${supadataHint}`,
          status: 400,
        });
        return res.end();
      }
      lines = mergeIntoSentences(result.lines);
      transcriptSource = `youtube:${result.language || 'auto'}`;
      send({ step: 2, step_progress: 100, overall_progress: 62, stage: 'Subtitles Ready', detail: `Loaded ${result.lines.length} caption cues merged into ${lines.length} lines.`, message: `Subtitles loaded — ${lines.length} lines.` });
    }

    // Every transcript line carries the same shape from here on:
    // { start, end, duration, text, engagement }
    lines = normaliseLines(lines);

    if (!duration) duration = lines[lines.length - 1].end;

    // ── Step 3 — search window + interest curve ────────────────────────────
    send({ step: 3, step_progress: 40, overall_progress: 66, stage: 'Scoring Retention', detail: 'Building the estimated interest curve...', message: 'Building estimated interest curve...' });

    let startBound = 0;
    let endBound = duration;
    const hasRange = body.range_start != null || body.range_end != null;
    if (hasRange) {
      startBound = body.range_start != null ? Number(body.range_start) : 0;
      endBound = body.range_end != null ? Number(body.range_end) : duration;
      startBound = Math.max(0, Math.min(startBound, duration));
      endBound = Math.max(0, Math.min(endBound, duration));
      if (startBound >= endBound) {
        send({ error: 'Invalid search range: the start time must be smaller than the end time.', status: 400 });
        return res.end();
      }
      lines = lines.filter((l) => Math.max(l.start, startBound) < Math.min(l.end, endBound));
      if (!lines.length) {
        send({ error: `No subtitles found between ${Math.round(startBound)}s and ${Math.round(endBound)}s.`, status: 400 });
        return res.end();
      }
    }

    const heatmap = buildEstimatedHeatmap(lines, endBound - startBound);
    for (const l of lines) l.engagement = engagementAt(heatmap, l.start, l.end);

    // ── Step 4 — AI ─────────────────────────────────────────────────────────
    const isLong = duration > 3600;
    const requestedCount = Number(body.target_clip_count) || 0;
    const clipRange = requestedCount
      ? `${Math.max(1, requestedCount - (requestedCount <= 5 ? 1 : requestedCount <= 10 ? 2 : 5))}-${requestedCount + (requestedCount <= 5 ? 2 : requestedCount <= 10 ? 3 : 5)}`
      : isLong ? '15-60' : '10-20';

    const requestedModel = (body.model || '').trim() || DEFAULT_MODEL;
    // Build the chain from the models this key can actually reach, so we never
    // burn a round trip on a model the plan does not cover.
    let available = null;
    try {
      available = await listModels(userKey, { timeoutMs: 12000 });
    } catch {
      /* fall back to the static preference order */
    }
    const chain = fallbackChain(requestedModel, available)
      .filter((m) => {
        if (isUnusable(m)) return false;
        return true;
      });
    if (!chain.length) {
      send({ error: 'No usable Ollama Cloud model is available for this API key.', status: 400 });
      return res.end();
    }
    const maxLines = isLong ? 1200 : 600;
    const trimmedForPrompt = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      log('info', `transcript ${lines.length} lines truncated to ${maxLines} for the prompt`);
    }
    const promptBody = buildUserPrompt({
      title,
      lines: trimmedForPrompt,
      heatmap,
      targetLength: DURATION_RANGE[body.duration] || DURATION_RANGE['30s'],
      clipRange,
      focus: (body.custom_prompt || '').trim(),
      startBound,
      endBound,
      duration,
    });

    send({ step: 4, step_progress: 15, overall_progress: 72, stage: 'Context Assembly', detail: `Sending ${trimmedForPrompt.length} dialogue lines to Ollama Cloud...`, message: `Assembling context for ${chain[0]}...` });

    let analysis = null;
    let usedModel = null;
    let lastError = '';

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      const next = chain[i + 1];
      send({ step: 4, step_progress: 20, overall_progress: 74, stage: 'Model Dispatch', detail: `Calling ${model} on Ollama Cloud...`, model, message: `Calling ${model}...` });

      // Heartbeat so the browser progress bar keeps moving during a long call.
      const heartbeat = setInterval(() => {
        send({ step: 4, keepalive: true, step_progress: 45, overall_progress: 80, stage: 'Analysing transcript', detail: `${model} is reading the transcript and ranking clip candidates...`, model });
      }, 5000);

      try {
        const { text } = await chat({
          model,
          apiKey: userKey,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: promptBody },
          ],
          temperature: 0.3,
          timeoutMs: 100000,
        });

        const parsed = extractJson(text);
        const clips = parsed ? normaliseClips(parsed.clips, lines, duration) : [];
        clearInterval(heartbeat);

        if (!clips.length) {
          lastError = `${model} returned no usable clips`;
          log('warn', `${model}: ${lastError}`);
          if (next) {
            send({ step: 4, step_progress: 35, overall_progress: 78, stage: 'Model Fallback', detail: `${model} found nothing usable — trying ${next}...`, model: next, message: `${model} returned 0 clips — switching to ${next}...` });
          }
          continue;
        }

        analysis = {
          summary: String(parsed.summary || '').replace(/#\w+/g, (m) => m.toLowerCase()).trim(),
          clips,
        };
        usedModel = model;
        break;
      } catch (err) {
        clearInterval(heartbeat);
        lastError = err?.message || String(err);
        log('warn', `${model} failed: ${lastError}`);
        if (err instanceof OllamaError && err.status === 401) throw err;
        if (next) {
          send({ step: 4, step_progress: 35, overall_progress: 78, stage: 'Model Fallback', detail: `${model} failed — trying ${next}...`, model: next, message: `${model} failed — switching to ${next}...` });
        }
      }
    }

    if (!analysis) {
      send({ error: `All Ollama Cloud models failed. Last error: ${lastError || 'unknown'}`, status: 502 });
      return res.end();
    }

    const clips = trimToTarget(analysis.clips, requestedCount || 0);

    send({
      step: 4, step_progress: 100, overall_progress: 100, stage: 'Analysis Complete',
      detail: `Found ${clips.length} clip candidates with ${usedModel}.`, done: true,
      result: {
        video_id: videoId,
        title,
        duration: Number((endBound - startBound).toFixed(2)),
        heatmap,
        summary: analysis.summary,
        clips,
        transcript: lines.map((l) => ({
          start: Number(l.start.toFixed(2)),
          end: Number(l.end.toFixed(2)),
          text: l.text,
          engagement: Number((l.engagement || 0).toFixed(3)),
        })),
        model: usedModel,
      },
    });
    return res.end();
  } catch (err) {
    log('error', `analyze failed: ${err?.stack || err}`);
    if (!res.headersSent) return fail(res, 500, err?.message || 'Analysis failed.');
    send({ error: err?.message || 'Analysis failed.', status: 500 });
    return res.end();
  }
}

function log(level, message) {
  const line = `[cheat-clip] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
