/**
 * Compares the free-tier Ollama Cloud models on a real transcript task.
 * Usage: node test-models.mjs
 */
import { normaliseLinesForTest } from './test-helpers.mjs';

const MODELS = ['gpt-oss:20b', 'nemotron-3-super', 'nemotron-3-nano:30b', 'nemotron-3-ultra', 'gemma4:31b', 'gpt-oss:120b'];
const KEY = process.env.OLLAMA_API_KEY || '';
const SYS = `You are a senior short-form video editor who finds viral moments in long YouTube videos.
You always answer with a single valid JSON object and nothing else.
Schema: {"summary":"string","clips":[{"title":"max 8 words","start_time":number,"end_time":number,"hook_time":number,"virality_score":1-100,"key_quotes":["string"],"transcript":"string","title_suggestion":"string","caption_suggestion":"string","hashtag_suggestion":"string"}]}
Timestamps MUST be copied exactly from the transcript. Titles must be third person (no I/me/my).`;

const TRANSCRIPT = [
  [0.0, 4.2, 'Welcome back to the channel everyone, today we are talking about going viral'],
  [4.2, 8.0, 'and I know you think the algorithm is broken and nothing works anymore'],
  [8.0, 12.5, 'But here is the thing nobody tells you about the retention curve'],
  [12.5, 17.0, 'Your first eight seconds decide everything, this is not a opinion it is measured data'],
  [17.0, 21.5, 'So what do you do when the first eight seconds are boring?'],
  [21.5, 26.0, 'You hook them with a promise, and then you pay it off inside the clip'],
  [26.0, 30.5, 'The biggest mistake I see is people delete the setup because they think it is boring'],
  [30.5, 35.0, 'But the setup is exactly what makes the payoff hit so hard'],
  [35.0, 39.5, 'Let me show you exactly how I did this on a channel with 400 subscribers'],
  [39.5, 44.0, 'One video went from 200 views to 90 thousand views in a single week'],
  [44.0, 48.5, 'And honestly the edit was not even that good, the structure was'],
  [48.5, 53.0, 'Try this on your next upload and tell me it did not work, I will be in the comments'],
];

const lines = normaliseLinesForTest(TRANSCRIPT);
const prompt = `Find 10-20 viral short-form clip candidates (TikTok / Reels / Shorts) from this YouTube transcript.

Source video title: How I Went Viral With 400 Subscribers
Target clip length: 20-40s

Transcript columns are: start|end|interest text
The third column is an ESTIMATED interest score, NOT real retention telemetry.

TRANSCRIPT
---
${lines.map((l) => `${l.start.toFixed(1)}|${l.end.toFixed(1)}|${l.engagement.toFixed(2)} ${l.text}`).join('\n')}
---

Return 10-20 clips sorted by virality_score descending, best first.`;

const strip = (t) => t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
function extractJson(text) {
  const clean = strip(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(clean); } catch {}
  const s = clean.search(/[{[]/); if (s === -1) return null;
  const open = clean[s], close = open === '{' ? '}' : ']';
  let d = 0, inStr = false, esc = false;
  for (let i = s; i < clean.length; i++) {
    const c = clean[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) d++;
    else if (c === close && --d === 0) { try { return JSON.parse(clean.slice(s, i + 1)); } catch { return null; } }
  }
  return null;
}

const rows = [];
for (const model of MODELS) {
  const t0 = Date.now();
  let status = 'ok', note = '';
  try {
    const res = await fetch('https://ollama.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model, stream: false, format: 'json', temperature: 0.3,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) { status = `HTTP ${res.status}`; rows.push({ model, status, secs: 0, clips: 0, valid: 0, note }); continue; }
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content || '';
    const parsed = extractJson(text);
    if (!parsed) { status = 'unparseable'; rows.push({ model, status, secs: (Date.now() - t0) / 1000, clips: 0, valid: 0, note: `len=${text.length}` }); continue; }
    const clips = Array.isArray(parsed.clips) ? parsed.clips : [];
    const times = new Set(lines.map((l) => l.start.toFixed(1)));
    const ends = new Set(lines.map((l) => l.end.toFixed(1)));
    let valid = 0, fp = 0, overlap = 0;
    const kept = [];
    for (const c of clips) {
      const s = Number(c.start_time), e = Number(c.end_time);
      if (Number.isFinite(s) && times.has(s.toFixed(1)) && Number.isFinite(e) && ends.has(e.toFixed(1)) && e > s) valid++;
      if (/\b(i|me|my|mine|myself|saya|aku|gue)\b/i.test(String(c.title || ''))) fp++;
      if (kept.some((k) => s < k.e && e > k.s)) overlap++;
      kept.push({ s, e });
    }
    const secs = (Date.now() - t0) / 1000;
    rows.push({ model, status, secs, clips: clips.length, valid, fp, overlap, summary: String(parsed.summary || '').slice(0, 45) });
  } catch (err) {
    rows.push({ model, status: 'ERR', secs: (Date.now() - t0) / 1000, clips: 0, valid: 0, note: err.message.slice(0, 40) });
  }
}

console.log('\n' + '='.repeat(96));
console.log('  MODEL                 STATUS        SECS   CLIPS  EXACT-TIMES  FIRST-PERSON  OVERLAP');
console.log('='.repeat(96));
for (const r of rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad(r.model, 20)} ${pad(r.status, 13)} ${pad((r.secs || 0).toFixed(1), 6)} ${pad(r.clips ?? '-', 6)} ${pad(r.valid ?? '-', 12)} ${pad(r.fp ?? '-', 14)} ${r.overlap ?? '-'}`);
}
console.log('='.repeat(96));
for (const r of rows.filter((x) => x.summary)) console.log(`  ${r.model}: "${r.summary}..."`);

const best = rows.filter((r) => r.status === 'ok' && r.valid > 0).sort((a, b) => b.valid - a.valid || a.secs - b.secs)[0];
console.log(`\n  ➜ Best: ${best ? best.model : 'none'} (${best?.valid} exact timestamp hits in ${best?.secs?.toFixed(1)}s)\n`);
process.exit(0);
