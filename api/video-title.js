/** GET /api/video-title?video_id=... — resolves a real title via YouTube oEmbed. */

import { cors, fail } from './_lib/http.js';
import { fetchTitle, extractVideoId } from './_lib/youtube.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return fail(res, 405, 'Use GET.');

  const raw = req.query?.video_id || '';
  const videoId = extractVideoId(raw) || (raw.length === 11 ? raw : null);
  if (!videoId) return fail(res, 400, 'A valid video_id is required.');

  const title = (await fetchTitle(videoId)) || `YouTube Video (${videoId})`;
  return res.status(200).json({ video_id: videoId, title });
}
