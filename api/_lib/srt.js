/** Parses user-uploaded SRT / VTT / timestamped-TXT subtitle files. */

/** "00:01:23,456" | "1:23" | "83.4" -> seconds */
export function parseTimeStr(timeStr) {
  const s = String(timeStr).trim().replace(',', '.');
  const [clock, frac = '0'] = s.split('.');
  const parts = clock.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2] + Number(`0.${frac}`);
  if (parts.length === 2) return parts[0] * 60 + parts[1] + Number(`0.${frac}`);
  if (parts.length === 1) return parts[0] + Number(`0.${frac}`);
  return 0;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * Accepts:
 *  - SRT blocks:  "12\n00:00:01,000 --> 00:00:04,500\ntext"
 *  - WebVTT cues
 *  - Plain lines prefixed with a timestamp: "[00:12] text", "00:12 - 00:15 text"
 *  - Bare text, which gets synthetic even spacing so it is still usable.
 */
export function parseManualSubtitles(content, defaultDuration = 0) {
  const text = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  // 1. SRT / WebVTT cue blocks
  const cueRe = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})([\s\S]*?)(?=\n\s*\n|\n\s*\d+\s*\n\s*\d{1,2}:\d{2}|$)/g;
  const cues = [];
  let m;
  while ((m = cueRe.exec(text)) !== null) {
    const start = parseTimeStr(m[1]);
    const end = parseTimeStr(m[2]);
    const body = stripTags(m[3].replace(/^\s*\d+\s*$/m, ''));
    if (body) cues.push({ text: body, start, duration: Math.max(0.1, end - start) });
  }
  if (cues.length) return cues;

  // 2. One timestamp per line
  const rangeRe = /^[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*(?:-|-->)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s*(.*)$/;
  const singleRe = /^[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s+(.*)$/;
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let match = line.match(rangeRe);
    if (match) {
      const start = parseTimeStr(match[1]);
      const body = stripTags(match[3]);
      if (body) lines.push({ text: body, start, duration: Math.max(0.1, parseTimeStr(match[2]) - start) });
      continue;
    }
    match = line.match(singleRe);
    if (match) {
      const body = stripTags(match[2]);
      if (body) lines.push({ text: body, start: parseTimeStr(match[1]), duration: 2.5 });
    }
  }
  if (lines.length) return lines;

  // 3. Untimestamped text — spread it evenly so the AI still has usable context.
  const rawLines = text
    .split('\n')
    .map(stripTags)
    .filter((l) => l.length > 1);
  if (!rawLines.length) return [];
  const span = defaultDuration > 0 ? defaultDuration : rawLines.length * 4;
  const step = span / rawLines.length;
  return rawLines.map((t, i) => ({ text: t, start: i * step, duration: step }));
}
