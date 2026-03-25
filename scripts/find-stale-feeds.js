const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const CUTOFF = Date.now() - SIX_MONTHS_MS;

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.substring(4);
    if (host === 'old.reddit.com') host = 'reddit.com';
    let p = u.pathname;
    if (p.endsWith('/')) p = p.slice(0, -1);
    return `${host}${p}${u.search}`;
  } catch {
    return url.toLowerCase().trim();
  }
}

function getHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 12);
}

function getLastCommitTime(filePath) {
  try {
    const info = execSync(`git log -1 --format=%ct ${filePath}`, { encoding: 'utf8' });
    return parseInt(info.trim(), 10) * 1000;
  } catch {
    return 0;
  }
}

function findStaleFeeds() {
  console.log('Finding stale feeds (not modified in 6+ months)...');

  const sourcesDir = path.join(__dirname, '../data/sources');
  if (!fs.existsSync(sourcesDir)) {
    console.log('No sources directory, nothing to clean');
    return;
  }

  const files = fs.readdirSync(sourcesDir).filter(f => f.endsWith('.json'));
  console.log(`Scanning ${files.length} source files...`);

  const staleFeeds = [];

  for (const file of files) {
    const filePath = path.join(sourcesDir, file);
    const lastCommitTime = getLastCommitTime(filePath);

    if (lastCommitTime < CUTOFF) {
      const source = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const feedUrl = Buffer.from(source.u, 'base64').toString('utf8');
      const hash = file.replace('.json', '');
      staleFeeds.push({ hash, feedUrl, lastCommitTime });
    }
  }

  console.log(`Found ${staleFeeds.length} stale feeds`);

  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dataDir, 'stale-feeds.json'),
    JSON.stringify(staleFeeds, null, 2)
  );
}

findStaleFeeds();