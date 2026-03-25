const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

async function clearUncachedFeeds() {
  console.log('Clearing successfully cached feeds from Firestore...');
  
  // Load user-feed mapping from scan script
  const userFeedsPath = path.join(__dirname, '../data/user-feeds.json');
  if (!fs.existsSync(userFeedsPath)) {
    console.log('No user-feeds.json found, skipping clear');
    return;
  }
  
  const userFeeds = JSON.parse(fs.readFileSync(userFeedsPath, 'utf8'));
  
  // Get all source files that were processed
  const sourcesDir = path.join(__dirname, '../data/sources');
  const processedHashes = new Set(fs.readdirSync(sourcesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', '')));
  
  console.log(`Processed ${processedHashes.size} feeds`);
  
  // For each user, clear successfully cached feeds
  for (const [userId, feeds] of Object.entries(userFeeds)) {
    const userDoc = db.collection('users').doc(userId);
    const userData = (await userDoc.get()).data();
    if (!userData) continue;
    
    const uncachedFeeds = userData.uncachedFeeds || [];
    const failedFeeds = userData.failedFeeds || [];
    
    const nextUncached = [];
    const nextFailed = [...failedFeeds];
    let changed = false;

    for (const url of uncachedFeeds) {
      const hash = getHash(normalizeUrl(url));
      const sourcePath = path.join(sourcesDir, `${hash}.json`);
      
      let failures = 0;
      let exists = false;
      if (fs.existsSync(sourcePath)) {
        exists = true;
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        failures = source.failures || 0;
      }

      if (exists && processedHashes.has(hash) && failures === 0) {
        // Success! Remove from uncached
        changed = true;
        console.log(`  [Success] ${url}`);
      } else if (failures >= 3) {
        // Too many failures. Move to failedFeeds
        changed = true;
        nextFailed.push({ url, failedAt: new Date().toISOString(), reason: 'Too many fetch failures' });
        console.log(`  [Failed] ${url} (3+ failures)`);
      } else {
        // Still uncached or retrying
        nextUncached.push(url);
      }
    }
    
    if (changed) {
      await userDoc.update({
        uncachedFeeds: nextUncached,
        failedFeeds: nextFailed
      });
      console.log(`Updated user ${userId}: ${uncachedFeeds.length} -> ${nextUncached.length} uncached, ${nextFailed.length} failed`);
    }
  }
}

// Helpers (same as scan script)
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

clearUncachedFeeds().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
