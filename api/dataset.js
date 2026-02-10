import crypto from 'node:crypto';
import DATASET_BASE64 from './data/dataset-base64.js';

const TTL_SECONDS = 300;

const getTokenFromRequest = (req) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return (req.headers['x-api-key'] || req.query?.token || '').toString().trim();
};

const computeHash = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

export default function handler(req, res) {
  const requiredToken = (process.env.DATASET_TOKEN || '').trim();
  const suppliedToken = getTokenFromRequest(req);

  // Require auth only when DATASET_TOKEN is configured.
  if (requiredToken && suppliedToken !== requiredToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const hash = computeHash(DATASET_BASE64);
  const version = (process.env.DATASET_VERSION || hash.slice(0, 12)).toString();
  const etag = `"${hash}"`;

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    `private, max-age=${TTL_SECONDS}, s-maxage=${TTL_SECONDS}, stale-while-revalidate=600`
  );
  res.setHeader('ETag', etag);

  res.status(200).json({
    version,
    hash,
    base64: DATASET_BASE64
  });
}
