const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

if (!DATABASE_URL || !REDIS_URL) {
  console.error('DATABASE_URL and REDIS_URL are required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
pool.on('error', (err) => console.error('pg pool error:', err.message));

// disableOfflineQueue: fail fast when Redis is down instead of waiting forever
const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true });
redis.on('error', (err) => console.error('redis error:', err.message));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// wraps async handlers so errors reach the error middleware instead of crashing
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function init() {
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS links (' +
          'code TEXT PRIMARY KEY, url TEXT NOT NULL, created_at TIMESTAMP DEFAULT now())'
      );
      ready = true;
    } catch (e) {
      console.log('waiting for postgres...');
      await sleep(1000);
    }
  }
  if (!ready) throw new Error('postgres not reachable');
  await redis.connect();
}

const app = express();
app.use(express.json());

app.get('/health', async (req, res) => {
  const status = {};
  try {
    await pool.query('SELECT 1');
    status.postgres = 'ok';
  } catch (e) {
    status.postgres = `error: ${e.message}`;
  }
  try {
    await redis.ping();
    status.redis = 'ok';
  } catch (e) {
    status.redis = `error: ${e.message}`;
  }
  const ok = Object.values(status).every((v) => v === 'ok');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error', instance: os.hostname(), ...status });
});

app.post('/shorten', wrap(async (req, res) => {
  const { url } = req.body || {};
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: 'invalid url' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'only http and https urls are allowed' });
  }
  const code = crypto.randomBytes(5).toString('base64url');
  await pool.query('INSERT INTO links (code, url) VALUES ($1, $2)', [code, parsed.href]);
  res.status(201).json({ code, short: `/${code}`, url: parsed.href });
}));

app.get('/stats/:code', wrap(async (req, res) => {
  const { code } = req.params;
  const { rows } = await pool.query('SELECT url FROM links WHERE code = $1', [code]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  const clicks = Number(await redis.get(`clicks:${code}`)) || 0;
  res.json({ code, url: rows[0].url, clicks });
}));

app.get('/:code', wrap(async (req, res) => {
  const { code } = req.params;
  let url = await redis.get(`link:${code}`);
  if (!url) {
    const { rows } = await pool.query('SELECT url FROM links WHERE code = $1', [code]);
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    url = rows[0].url;
    await redis.set(`link:${code}`, url, { EX: 3600 });
  }
  await redis.incr(`clicks:${code}`);
  res.redirect(302, url);
}));

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'internal error' });
});

init()
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => console.log(`listening on ${PORT}`));
    // Node as PID 1 ignores SIGTERM by default, so handle it for clean `docker stop`
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
