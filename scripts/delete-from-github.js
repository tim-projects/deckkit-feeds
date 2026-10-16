const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DRY_RUN = process.env.DRY_RUN === 'true';

function deleteFromGitHub() {
  console.log(DRY_RUN ? '[DRY RUN] Would delete stale feeds from GitHub...' : 'Deleting stale feeds from GitHub...');

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
  const existingFeeds = staleFeeds.filter(feed => fs.existsSync(path.join(sourcesDir, `${feed.hash}.json`)));

  console.log('\nSource files that would be deleted from GitHub:');
  console.log('='.repeat(60));
  existingFeeds.forEach((feed, idx) => {
    const date = feed.lastCommitTime ? new Date(feed.lastCommitTime).toISOString().split('T')[0] : 'unknown';
    console.log(`${idx + 1}. Hash: ${feed.hash}`);
    console.log(`   URL: ${feed.feedUrl}`);
    console.log(`   Last commit: ${date}`);
    console.log(`   Would delete: data/sources/${feed.hash}.json`);
    console.log('');
  });
  console.log('='.repeat(60));
  console.log(`Total: ${existingFeeds.length} source files would be deleted\n`);

  const deleted = [];

  for (const feed of staleFeeds) {
    const hash = feed.hash;
    const sourcePath = path.join(sourcesDir, `${hash}.json`);

    if (fs.existsSync(sourcePath)) {
      console.log(`  [DRY RUN] Would delete data/sources/${hash}.json`);
      deleted.push(hash);
      // TODO: Uncomment when dry run is proven
      /*
      fs.unlinkSync(sourcePath);
      console.log(`  Deleted data/sources/${hash}.json`);
      */
    }
  }

  console.log(DRY_RUN ? `[DRY RUN] Would delete ${deleted.length} source files from GitHub` : `Deleted ${deleted.length} source files from GitHub`);
}

deleteFromGitHub();