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

async function main() {
    if (!fs.existsSync(SOURCES_DIR)) process.exit(0);
    const sourceFiles = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));
    console.log(`Ingesting ${sourceFiles.length} sources to R2...`);

    for (const file of sourceFiles) {
        const sourcePath = path.join(SOURCES_DIR, file);
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const sourceHash = file.replace('.json', '');
        const feedUrl = Buffer.from(source.u, 'base64').toString('utf8');

        try {
            const ingestor = IngestorFactory.getIngestor(feedUrl, s3, BUCKET_NAME);
            const result = await ingestor.run(source, sourceHash, feedUrl);

            if (result.success) {
                if (!result.skip) {
                    source.etag = result.etag || "";
                    source.lastModified = result.lastModified || "";
                    source.failures = 0; // Reset failures on success
                    fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
                }
            } else {
                console.error(`  !! Ingestion Error ${sourceHash}: ${result.error}`);
                source.failures = (source.failures || 0) + 1;
                fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
            }
        } catch (err) {
            console.error(`  !! Processing Error ${sourceHash}: ${err.message}`);
            source.failures = (source.failures || 0) + 1;
            fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
