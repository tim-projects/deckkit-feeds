const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function deleteFromGitHub() {
  console.log('Deleting stale feeds from GitHub...');

  const staleFeedsPath = path.join(__dirname, '../data/stale-feeds.json');
  if (!fs.existsSync(staleFeedsPath)) {
    console.log('No stale-feeds.json found, skipping GitHub deletion');
    return;
  }

  const staleFeeds = JSON.parse(fs.readFileSync(staleFeedsPath, 'utf8'));
  if (staleFeeds.length === 0) {
    console.log('No stale feeds to delete from GitHub');
    return;
  }

  const sourcesDir = path.join(__dirname, '../data/sources');
  const deleted = [];

  for (const feed of staleFeeds) {
    const hash = feed.hash;
    const sourcePath = path.join(sourcesDir, `${hash}.json`);

    if (fs.existsSync(sourcePath)) {
      fs.unlinkSync(sourcePath);
      console.log(`  Deleted data/sources/${hash}.json`);
      deleted.push(hash);
    }
  }

  console.log(`Deleted ${deleted.length} source files from GitHub`);
}

deleteFromGitHub();