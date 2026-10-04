/**
 * Engagement signal for the heatmap.
 *
 * IMPORTANT / HONESTY NOTE
 * ------------------------
 * YouTube's real "most watched" retention curve lives in a private engagement
 * panel that InnerTube no longer exposes to anonymous requests (verified: the
 * `/next` endpoint returns storyboard data but no `mostWatched` field). The
 * upstream project obtained it through yt-dlp, which cannot run on Vercel.
 *
 * So instead of pretending we have retention telemetry, we derive a clearly
 * labelled *estimated* interest curve from the transcript itself, using signals
 * that genuinely correlate with rewatch-worthy moments:
 *
 *   - questions / curiosity gaps   ("why", "how", "what if", "but wait")
 *   - emotional intensity          (exclamations, superlatives, laughter)
 *   - surprising numbers & lists
 *   - speech density (words/second)
 *   - the classic intro/hook decay at the very start
 *
 * The AI prompt is told plainly that this is an estimate, so it never presents
 * a heuristic as a real audience-retention measurement.
 */

/** Words that signal a hook, reveal, or curiosity gap. */
const HOOK_WORDS = [
  'why', 'how', 'what if', 'but wait', 'secret', 'never told', 'nobody talks',
  'biggest', 'worst', 'best', 'mistake', 'truth', 'actually', 'turns out',
  'here is why', 'here why', 'imagine', 'guess what', 'believe it or not',
  'the reason', 'changed everything', 'changed my', 'nobody expects',
];

/** Emotion / hype markers. */
const EMOTION_WORDS = [
  'amazing', 'incredible', 'insane', 'crazy', 'shocking', 'unbelievable',
  'worst', 'best', 'huge', 'massive', 'love', 'hate', 'furious', 'scared',
  'wow', 'oh my', 'damn', 'savage', 'hilarious', 'epic', 'legendary',
];

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Scores one transcript line on a 0..1 interest scale. */
function scoreLine(line, index, total) {
  const text = (line.text || '').toLowerCase();
  if (!text) return 0.25;

  let score = 0.2;

  if (HOOK_WORDS.some((w) => text.includes(w))) score += 0.22;
  if (EMOTION_WORDS.some((w) => text.includes(w))) score += 0.16;
  if (/[!?]/.test(text)) score += 0.1;
  if (/\b\d{2,}\b/.test(text)) score += 0.06;
  if (/\b(first|second|third|finally|step \d)\b/.test(text)) score += 0.05;
  if (/\b(i (never|always|used to)|back then|years ago)\b/.test(text)) score += 0.07;

  // Density: fast, information-dense delivery tends to hold attention.
  const words = text.split(/\s+/).filter(Boolean).length;
  const dur = Math.max(0.5, line.duration || 2.5);
  const wps = words / dur;
  if (wps > 3.2) score += 0.1;
  else if (wps > 2.4) score += 0.05;
  else if (wps < 1.1) score -= 0.04;

  // Classic cold-open decay: the first ~3% of a video loses viewers.
  const pos = total > 1 ? index / (total - 1) : 0;
  if (pos < 0.03) score -= 0.12;

  // Gentle arc bonus so the curve reads like a real retention graph.
  score += 0.05 * Math.sin(pos * Math.PI);

  return clamp01(score);
}

/**
 * Builds a binned heatmap across the whole video duration.
 * @returns {{ start_time:number, end_time:number, value:number }[]}
 */
export function buildEstimatedHeatmap(transcript, duration, { buckets = 90 } = {}) {
  if (!transcript || !transcript.length) return [];

  const total = duration || transcript[transcript.length - 1].start + 4;
  const size = Math.max(4, Math.min(400, buckets));
  const bin = total / size;
  const acc = new Float64Array(size);
  const cnt = new Float64Array(size);

  transcript.forEach((line, i) => {
    const s = scoreLine(line, i, transcript.length);
    const from = Math.max(0, Math.min(size - 1, Math.floor(line.start / bin)));
    const to = Math.max(0, Math.min(size - 1, Math.floor((line.start + line.duration) / bin)));
    for (let b = from; b <= to; b++) {
      acc[b] += s;
      cnt[b] += 1;
    }
  });

  const raw = Array.from({ length: size }, (_, i) => (cnt[i] ? acc[i] / cnt[i] : null));
  const known = raw.filter((v) => v !== null);
  if (!known.length) return [];

  // Normalise against the video's own range so the curve always uses full contrast.
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;

  // Fill silent gaps by interpolating, so the timeline never shows holes.
  const filled = raw.map((v, i) => {
    if (v !== null) return v;
    let prev = i - 1;
    while (prev >= 0 && raw[prev] === null) prev--;
    let next = i + 1;
    while (next < size && raw[next] === null) next++;
    const a = prev >= 0 ? raw[prev] : min;
    const b = next < size ? raw[next] : min;
    const t = (i - prev) / Math.max(1, next - prev);
    return a + (b - a) * t;
  });

  // Light 3-point smoothing removes single-line spikes from the curve.
  const smooth = filled.map((v, i) => {
    const a = filled[i - 1] ?? v;
    const b = filled[i + 1] ?? v;
    return (a + v * 2 + b) / 4;
  });

  return smooth.map((v, i) => ({
    start_time: Number((i * bin).toFixed(2)),
    end_time: Number(((i + 1) * bin).toFixed(2)),
    value: Number(clamp01((v - min) / span).toFixed(3)),
  }));
}

/** Average interest over a time window, used to annotate each transcript line. */
export function engagementAt(heatmap, start, end) {
  if (!heatmap || !heatmap.length) return 0;
  let sum = 0;
  let n = 0;
  for (const p of heatmap) {
    if (Math.max(start, p.start_time) < Math.min(end, p.end_time)) {
      sum += p.value;
      n++;
    }
  }
  if (n) return sum / n;
  const mid = (start + end) / 2;
  let best = heatmap[0];
  let bestDist = Infinity;
  for (const p of heatmap) {
    const d = Math.abs((p.start_time + p.end_time) / 2 - mid);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best.value;
}
