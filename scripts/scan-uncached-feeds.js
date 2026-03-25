const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCES_DIR = path.join(__dirname, '../data/sources');

// Initialize Firebase
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  // Ensure private key handles newlines correctly if stored as a single string
  privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
};

if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
  console.error("Missing Firebase credentials. Exiting.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.substring(4);
    if (host === 'old.reddit.com') host = 'reddit.com';
    let path = u.pathname;
    if (path.endsWith('/')) path = path.slice(0, -1);
    return `${host}${path}${u.search}`;
  } catch {
    return url.toLowerCase().trim();
  }
}

function getHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 12);
}

async function scanUncachedFeeds() {
  console.log('Scanning Firestore for uncached feeds...');
  
  if (!fs.existsSync(SOURCES_DIR)) {
    fs.mkdirSync(SOURCES_DIR, { recursive: true });
  }

  // Track user -> feed mappings for later cleanup
  const userFeeds = {}; // { "userId": ["url1", "url2"] }
  const allFeeds = new Set();

  // Query all users with uncachedFeeds
  const snapshot = await db.collection('users').get();
  
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uncachedFeeds = data.uncachedFeeds || [];
    
    if (uncachedFeeds.length === 0) continue;
    
    userFeeds[doc.id] = uncachedFeeds;
    
    for (const feedUrl of uncachedFeeds) {
      if (allFeeds.has(feedUrl)) continue;
      allFeeds.add(feedUrl);
      
      const normalized = normalizeUrl(feedUrl);
      const hash = getHash(normalized);
      
      const sourcePath = path.join(SOURCES_DIR, `${hash}.json`);
      
      if (!fs.existsSync(sourcePath)) {
        // Create new source file
        const source = {
          u: Buffer.from(feedUrl).toString('base64'),
          h: hash,
          registeredAt: new Date().toISOString()
        };
        fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
        console.log(`Created source: ${hash} -> ${feedUrl}`);
      }
    }
  }

  console.log(`Found ${allFeeds.size} unique uncached feeds from ${Object.keys(userFeeds).length} users`);
  
  // Save user-feed mapping for clear script
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'user-feeds.json'), JSON.stringify(userFeeds, null, 2));
}

scanUncachedFeeds().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
