/**
 * Local end-to-end test for the serverless handlers.
 * Usage: node test-api.mjs
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const PORT = 8899;

function makeRes() {
  const chunks = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  return {
    statusCode: 200,
    headers: {},
    body: null,
    sseChunks: [],
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(obj) { this.body = obj; resolveDone(); return this; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
    write(chunk) { this.sseChunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk) this.sseChunks.push(String(chunk)); resolveDone(); return this; },
    get done() { return done; },
  };
}

async function run(modPath, { method = 'GET', query = {}, body = null, headers = {} } = {}) {
  const mod = await import(modPath);
  const req = { method, query, headers, body };
  const res = makeRes();
  await mod.default(req, res);
  await res.done;
  return res;
}

/** Splits an SSE body into parsed JSON frames. */
function parseSse(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) return null;
      try { return JSON.parse(line.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Keep the process alive while async handlers run.
const keepAlive = setInterval(() => {}, 1000);
const finish = (code) => { clearInterval(keepAlive); process.exit(code); };

console.log('\n=== 1. /api/health ===');
{
  const res = await run('./api/health.js');
  check('health 200', res.statusCode === 200, JSON.stringify(res.body));
  check('key configured', res.body?.ollama_key_configured === true);
}

console.log('\n=== 2. /api/models ===');
{
  const res = await run('./api/models.js', { method: 'POST' });
  const models = res.body?.models || [];
  check('models returned', models.length > 0, `${models.length} models`);
  check('default set', Boolean(res.body?.default), res.body?.default);
  check('no gemini models', !models.some((m) => /gemini/i.test(m)));
}

console.log('\n=== 3. /api/video-title ===');
{
  const res = await run('./api/video-title.js', { query: { video_id: 'dQw4w9WgXcQ' } });
  check('title resolved', Boolean(res.body?.title), res.body?.title);
}

console.log('\n=== 4. /api/supadata-usage (compat stub) ===');
{
  const res = await run('./api/supadata-usage.js');
  check('stub ok', res.statusCode === 200 && res.body?.total_keys === 0);
}

console.log('\n=== 5. /api/analyze — mock mode ===');
{
  const res = await run('./api/analyze.js', {
    method: 'POST',
    headers: { 'x-ollama-api-key': 'mock' },
    body: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: '30s' },
  });
  const events = parseSse(res.sseChunks);
  const done = events.find((e) => e.done);
  check('SSE frames streamed', events.length > 0, `${events.length} events`);
  check('has done event', Boolean(done));
  check('clips present', (done?.result?.clips?.length || 0) > 0, `${done?.result?.clips?.length} clips`);
  check('heatmap present', (done?.result?.heatmap?.length || 0) > 0, `${done?.result?.heatmap?.length} points`);
}

console.log('\n=== 6. /api/analyze — invalid URL ===');
{
  const res = await run('./api/analyze.js', {
    method: 'POST',
    body: { url: 'not-a-youtube-link' },
  });
  const events = parseSse(res.sseChunks);
  check('error event emitted', Boolean(events.find((e) => e.error)), events.find((e) => e.error)?.error?.slice(0, 60));
}

console.log('\n=== 7. /api/analyze — REAL YouTube video + Ollama Cloud ===');
{
  const t0 = Date.now();
  const res = await run('./api/analyze.js', {
    method: 'POST',
    body: {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      duration: '30s',
      target_clip_count: 3,
    },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const events = parseSse(res.sseChunks);
  const err = events.find((e) => e.error);
  const done = events.find((e) => e.done);

  check('completed without error', Boolean(done), err ? `ERROR: ${err.error}` : `${secs}s`);
  if (done) {
    const r = done.result;
    check('title present', Boolean(r.title), r.title);
    check('duration positive', r.duration > 0, `${r.duration}s`);
    check('model used', Boolean(r.model), r.model);
    check('transcript lines', (r.transcript?.length || 0) > 0, `${r.transcript?.length} lines`);
    check('heatmap points', (r.heatmap?.length || 0) > 0, `${r.heatmap?.length}`);
    check('clips returned', (r.clips?.length || 0) > 0, `${r.clips?.length} clips`);
    check('respects target count', (r.clips?.length || 0) <= 3, `${r.clips?.length}`);
    check('summary present', Boolean(r.summary), r.summary?.slice(0, 70));
    const first = r.clips?.[0];
    if (first) {
      check('clip has title', Boolean(first.title), first.title);
      check('clip times valid', first.start_time < first.end_time, `${first.start_time} → ${first.end_time}`);
      check('clip has transcript', Boolean(first.transcript), first.transcript?.slice(0, 60));
      check('score in range', first.virality_score >= 1 && first.virality_score <= 100, String(first.virality_score));
      check('has caption', Boolean(first.caption_suggestion), first.caption_suggestion?.slice(0, 50));
      check('has hashtags', Boolean(first.hashtag_suggestion), first.hashtag_suggestion);
      // no first person in titles
      const fp = /\b(i|me|my|mine|myself|saya|aku|gue)\b/i;
      check('no first-person in title', !fp.test(first.title), first.title);
    }
    const overlapping = r.clips.some((c, i) =>
      r.clips.slice(0, i).some((p) => c.start_time < p.end_time && c.end_time > p.start_time)
    );
    check('clips do not overlap', !overlapping);
    const sorted = r.clips.every((c, i) => i === 0 || r.clips[i - 1].virality_score >= c.virality_score);
    check('clips sorted by score', sorted);
  }
}

console.log('\n=== 8. /api/analyze — manual subtitles path ===');
{
  const res = await run('./api/analyze.js', {
    method: 'POST',
    body: {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      duration: '30s',
      target_clip_count: 2,
      subtitles: '1\n00:00:00,000 --> 00:00:06,000\nWelcome back to the channel everyone.\n\n2\n00:00:06,000 --> 00:00:12,000\nThe secret nobody tells you about going viral is simple.\n\n3\n00:00:12,000 --> 00:00:18,000\nStop guessing and look at the retention data instead.\n\n4\n00:00:18,000 --> 00:00:25,000\nThat single change doubled my views in one month.\n',
    },
  });
  const events = parseSse(res.sseChunks);
  const done = events.find((e) => e.done);
  const err = events.find((e) => e.error);
  check('manual subtitles analyzed', Boolean(done), err ? `ERROR: ${err.error}` : '');
  if (done) check('clips from uploaded subs', (done.result.clips?.length || 0) > 0, `${done.result.clips?.length} clips`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${'='.repeat(52)}\n  ${passed}/${results.length} checks passed\n${'='.repeat(52)}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nFailures:');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
finish(failed.length ? 1 : 0);
