const fs = require('fs');
const path = require('path');
const { S3Client, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = 'deckkit-feeds';

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error("Missing R2 credentials. Exiting.");
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

async function deleteFromR2() {
  console.log('Deleting stale feeds from R2...');

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

  const deleted = [];

  for (const feed of staleFeeds) {
    const hash = feed.hash;

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
  }

  console.log(`Deleted ${deleted.length} feeds from R2`);
}

deleteFromR2().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });