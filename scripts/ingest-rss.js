const fs = require('fs');
const path = require('path');
const { S3Client } = require('@aws-sdk/client-s3');
const IngestorFactory = require('../lib/IngestorFactory');

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

const SOURCES_DIR = path.join(__dirname, '../data/sources');

const REDDIT_REQUEST_DELAY_MS = 65_000; // ~1 minute between Reddit requests
const REDDIT_COOLDOWN_MS = 10 * 60_000; // skip Reddit feeds fetched within last 10 minutes

function isRedditUrl(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        return hostname === 'old.reddit.com' || hostname === 'reddit.com';
    } catch {
        return false;
    }
}

function updateSource(source, sourcePath, updates) {
    Object.assign(source, updates);
    fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
}

async function main() {
    if (!fs.existsSync(SOURCES_DIR)) process.exit(0);
    const sourceFiles = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));

    const sourcesWithMeta = sourceFiles.map(file => {
        const sourcePath = path.join(SOURCES_DIR, file);
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const lastFetched = source.lastFetchedAt ? new Date(source.lastFetchedAt).getTime() : 0;
        return { file, sourcePath, source, lastFetched };
    });

    sourcesWithMeta.sort((a, b) => a.lastFetched - b.lastFetched);

    console.log(`Ingesting ${sourcesWithMeta.length} sources to R2...`);

    for (const { file, sourcePath, source } of sourcesWithMeta) {
        const sourceHash = file.replace('.json', '');
        const feedUrl = Buffer.from(source.u, 'base64').toString('utf8');

        if (!feedUrl || feedUrl.startsWith('#') || !/^https?:\/\//i.test(feedUrl)) {
            console.error(`  !! Skipping ${sourceHash}: Invalid URL "${feedUrl}"`);
            updateSource(source, sourcePath, {
                failures: (source.failures || 0) + 1,
                lastError: `Invalid URL: ${feedUrl}`,
                brokenSince: source.brokenSince || new Date().toISOString(),
            });
            continue;
        }

        const reddit = isRedditUrl(feedUrl);
        const now = Date.now();
        const lastFetched = source.lastFetchedAt ? new Date(source.lastFetchedAt).getTime() : 0;

        if (reddit && lastFetched && (now - lastFetched < REDDIT_COOLDOWN_MS)) {
            console.log(`  -> Skipping ${sourceHash}: Reddit cooldown (last fetched ${new Date(source.lastFetchedAt).toISOString()})`);
            continue;
        }

        try {
            const ingestor = IngestorFactory.getIngestor(feedUrl, s3, BUCKET_NAME);
            const result = await ingestor.run(source, sourceHash, feedUrl);

            if (reddit) {
                updateSource(source, sourcePath, { lastFetchedAt: new Date().toISOString() });
            }

            if (result.success) {
                if (!result.skip) {
                    updateSource(source, sourcePath, {
                        etag: result.etag || "",
                        lastModified: result.lastModified || "",
                        failures: 0,
                    });
                    delete source.brokenSince;
                    delete source.lastError;
                    fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
                }
            } else {
                console.error(`  !! Ingestion Error ${sourceHash}: ${result.error}`);
                updateSource(source, sourcePath, {
                    failures: (source.failures || 0) + 1,
                    lastError: result.error,
                    brokenSince: source.brokenSince || new Date().toISOString(),
                });
            }
        } catch (err) {
            console.error(`  !! Processing Error ${sourceHash}: ${err.message}`);
            if (reddit) {
                updateSource(source, sourcePath, { lastFetchedAt: new Date().toISOString() });
            }
            updateSource(source, sourcePath, {
                failures: (source.failures || 0) + 1,
                lastError: err.message,
                brokenSince: source.brokenSince || new Date().toISOString(),
            });
        }

        if (reddit) {
            console.log(`  -> Waiting ${REDDIT_REQUEST_DELAY_MS / 1000}s before next Reddit request...`);
            await new Promise(resolve => setTimeout(resolve, REDDIT_REQUEST_DELAY_MS));
        }
    }
}

main().catch(e => { console.error(e); process.exit(1) });
