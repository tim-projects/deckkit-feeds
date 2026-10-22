const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const IngestorFactory = require('../lib/IngestorFactory');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = 'deckkit-feeds';
const SOURCES_DIR = path.join(__dirname, '../data/sources');

const DRY_RUN = process.env.DRY_RUN === 'true';

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

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { sourceHash: null, url: null, prune: false };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--source':
                opts.sourceHash = args[++i];
                break;
            case '--url':
                opts.url = args[++i];
                break;
            case '--prune':
                opts.prune = true;
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
        }
    }
    return opts;
}

async function pruneStaleItems(s3, sourceHash, currentItemHashes) {
    console.log(`  -> Pruning stale items for ${sourceHash}...`);
    const currentKeys = new Set(currentItemHashes.map(h => `items/${sourceHash}/${h}.json`));
    let continuationToken;
    let deleted = 0;
    do {
        const params = { Bucket: BUCKET_NAME, Prefix: `items/${sourceHash}/` };
        if (continuationToken) params.ContinuationToken = continuationToken;
        const resp = await s3.send(new ListObjectsV2Command(params));
        if (resp.Contents) {
            for (const obj of resp.Contents) {
                if (!currentKeys.has(obj.Key)) {
                    if (!DRY_RUN) {
                        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key }));
                    }
                    console.log(`    ${DRY_RUN ? '[DRY RUN] Would delete' : 'Deleted'} ${obj.Key}`);
                    deleted++;
                }
            }
        }
        continuationToken = resp.NextContinuationToken;
    } while (continuationToken);
    console.log(`  -> Pruning complete: ${deleted} stale item(s) removed`);
    return deleted;
}

async function main() {
    if (!process.env.R2_ACCOUNT_ID && !DRY_RUN) {
        console.error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).');
        console.error('Set DRY_RUN=true to run without credentials.');
        process.exit(1);
    }

    const opts = parseArgs();

    if (!opts.sourceHash && !opts.url) {
        console.error('Usage: node scripts/reprocess-feed.js --source <hash> | --url <url> [--prune] [--dry-run]');
        process.exit(1);
    }

    if (opts.url) {
        const normalized = normalizeUrl(opts.url);
        const hash = getHash(normalized);
        opts.sourceHash = hash;
    }

    const feedUrl = opts.url || Buffer.from(
        JSON.parse(fs.readFileSync(path.join(SOURCES_DIR, `${opts.sourceHash}.json`), 'utf8')).u,
        'base64'
    ).toString('utf8');

    const sourcePath = path.join(SOURCES_DIR, `${opts.sourceHash}.json`);
    let source;
    if (fs.existsSync(sourcePath)) {
        source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    } else {
        source = {
            u: Buffer.from(feedUrl, 'utf8').toString('base64'),
            h: opts.sourceHash,
            registeredAt: new Date().toISOString(),
        };
        console.log(`  -> Created new source file: ${sourcePath}`);
    }

    console.log(`Reprocessing feed: ${opts.sourceHash}`);
    console.log(`  Source: ${feedUrl}`);
    console.log(`  Mode: ${DRY_RUN || opts.dryRun ? 'DRY RUN' : 'LIVE'}`);

    if (DRY_RUN || opts.dryRun) {
        process.env.DRY_RUN = 'true';
    }

    const s3 = (DRY_RUN) ? null : new S3Client({
        region: 'auto',
        endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
        },
    });

    const ingestor = IngestorFactory.getIngestor(feedUrl, s3, BUCKET_NAME);

    const forceOptions = { force: true };

    if (DRY_RUN) {
        console.log('[DRY RUN] Would reprocess with force=true, uploading items and manifest to R2');
        console.log(`[DRY RUN] Items would be written to: items/${opts.sourceHash}/`);
        console.log(`[DRY RUN] Manifest would be written to: feeds/${opts.sourceHash}.json`);
        process.exit(0);
    }

    const result = await ingestor.run(source, opts.sourceHash, feedUrl, forceOptions);

    if (result.skip) {
        console.log(`  -> Skipped (not modified) - but this shouldn't happen with force=true`);
        process.exit(0);
    }

    if (!result.success) {
        console.error(`  !! Failed: ${result.error}`);
        process.exit(1);
    }

    console.log(`  -> Feed reprocessed successfully`);
    console.log(`  -> Updated etag: ${result.etag || '(none)'}`);
    console.log(`  -> Updated lastModified: ${result.lastModified || '(none)'}`);

    if (result.manifest) {
        if (opts.prune) {
            const itemHashes = result.manifest.map(m => m.h);
            await pruneStaleItems(s3, opts.sourceHash, itemHashes);
        }
    }

    const updates = {
        etag: result.etag || '',
        lastModified: result.lastModified || '',
        failures: 0,
        lastReprocessedAt: new Date().toISOString(),
    };
    Object.assign(source, updates);
    delete source.brokenSince;
    delete source.lastError;
    fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
    console.log(`  -> Updated source metadata: ${sourcePath}`);

    console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
