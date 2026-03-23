const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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

const POPULARITY_PATH = path.join(__dirname, '../data/popularity.json');
const SOURCES_DIR = path.join(__dirname, '../data/sources');

// --- Scoring Constants ---
const HOUR_IN_MS = 1000 * 60 * 60;
const IMAGE_BOOST = 6 * HOUR_IN_MS;
const DIVERSITY_PENALTY = 4 * HOUR_IN_MS;

async function generate() {
    console.log("Starting Demo Deck Generation...");

    if (!fs.existsSync(POPULARITY_PATH)) {
        console.error("Popularity map not found. Skipping.");
        return;
    }

    const popularity = JSON.parse(fs.readFileSync(POPULARITY_PATH, 'utf8'));
    const feedPopularity = popularity.feeds || {};
    const itemPopularity = popularity.items || {};

    const allItems = [];
    const sourceFiles = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));

    console.log(`Processing ${sourceFiles.length} sources...`);

    for (const file of sourceFiles) {
        const sourceHash = file.replace('.json', '');
        const manifestPath = path.join(__dirname, `../data/manifests/${sourceHash}.json`);
        
        if (!fs.existsSync(manifestPath)) continue;

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const subCount = feedPopularity[sourceHash] || 0;
        const subBoost = Math.log10(subCount + 1) * 12 * HOUR_IN_MS;

        for (const entry of manifest) {
            const itemPath = path.join(__dirname, `../data/items/${sourceHash}/${entry.h}.json`);
            if (!fs.existsSync(itemPath)) continue;

            const item = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
            const starCount = itemPopularity[entry.h] || 0;
            const starBoost = starCount * 6 * HOUR_IN_MS;

            let score = new Date(item.pubDate || item.published).getTime();
            if (item.image) score += IMAGE_BOOST;
            score += subBoost;
            score += starBoost;

            allItems.push({ ...item, score, sourceHash });
        }
    }

    // Sort and Apply Diversity Penalty
    allItems.sort((a, b) => b.score - a.score);

    const sourceCounts = {};
    const finalItems = [];
    
    for (const item of allItems) {
        if (finalItems.length >= 10) break;
        
        const source = item['deckkit:source'] || item.sourceHash;
        const count = sourceCounts[source] || 0;
        const penalty = count * DIVERSITY_PENALTY;
        
        item.score -= penalty;
        sourceCounts[source] = count + 1;
        finalItems.push(item);
    }

    // Re-sort final top 10
    finalItems.sort((a, b) => b.score - a.score);

    const payload = JSON.stringify({
        updatedAt: new Date().toISOString(),
        items: finalItems.map(({ score, sourceHash, ...rest }) => rest), // Strip score and internal metadata
    }, null, 2);

    console.log(`Generated demo deck with ${finalItems.length} items.`);

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: 'demo-deck.json',
        Body: payload,
        ContentType: 'application/json',
        CacheControl: 'public, max-age=300',
    }));

    console.log("Uploaded demo-deck.json to R2.");
}

generate().catch(console.error);
