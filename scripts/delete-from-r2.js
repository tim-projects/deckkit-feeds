const fs = require('fs');
const path = require('path');
const { S3Client, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const DRY_RUN = process.env.DRY_RUN === 'true';
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = 'deckkit-feeds';

if (!DRY_RUN && (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY)) {
  console.error("Missing R2 credentials. Exiting.");
  process.exit(1);
}

const s3 = !DRY_RUN ? new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
}) : null;

async function deleteFromR2() {
  console.log(DRY_RUN ? '[DRY RUN] Would delete stale feeds from R2...' : 'Deleting stale feeds from R2...');

  const staleFeedsPath = path.join(__dirname, '../data/stale-feeds.json');
  if (!fs.existsSync(staleFeedsPath)) {
    console.log('No stale-feeds.json found, skipping R2 deletion');
    return;
  }

  const staleFeeds = JSON.parse(fs.readFileSync(staleFeedsPath, 'utf8'));
  if (staleFeeds.length === 0) {
    console.log('No stale feeds to delete from R2');
    return;
  }

  console.log('\nFeeds that would be deleted from R2:');
  console.log('='.repeat(60));
  staleFeeds.forEach((feed, idx) => {
    const date = feed.lastCommitTime ? new Date(feed.lastCommitTime).toISOString().split('T')[0] : 'unknown';
    console.log(`${idx + 1}. Hash: ${feed.hash}`);
    console.log(`   URL: ${feed.feedUrl}`);
    console.log(`   Last commit: ${date}`);
    console.log(`   Would delete: feeds/${feed.hash}.json`);
    console.log(`                   items/${feed.hash}/...`);
    console.log('');
  });
  console.log('='.repeat(60));
  console.log(`Total: ${staleFeeds.length} feeds would be deleted\n`);

  const deleted = [];

  for (const feed of staleFeeds) {
    const hash = feed.hash;

    console.log(`  [DRY RUN] Would delete feeds/${hash}.json`);
    console.log(`  [DRY RUN] Would delete items/${hash}/...`);
    deleted.push(hash);
    // TODO: Uncomment when dry run is proven
    /*
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `feeds/${hash}.json`,
      }));
      deleted.push(hash);
      console.log(`  Deleted feeds/${hash}.json`);
    } catch (e) {
      console.error(`  Failed to delete feeds/${hash}.json: ${e.message}`);
    }

    try {
      const listResp = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: `items/${hash}/`,
      }));

      if (listResp.Contents) {
        for (const obj of listResp.Contents) {
          await s3.send(new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: obj.Key,
          }));
          console.log(`  Deleted ${obj.Key}`);
        }
      }
    } catch (e) {
      console.error(`  Failed to delete items/${hash}/: ${e.message}`);
    }
    */
  }

  console.log(DRY_RUN ? `[DRY RUN] Would delete ${deleted.length} feeds from R2` : `Deleted ${deleted.length} feeds from R2`);
}

deleteFromR2().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });