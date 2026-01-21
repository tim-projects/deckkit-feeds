const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Parser = require('rss-parser');
const sanitizeHtml = require('sanitize-html');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// --- R2 Configuration ---
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

const parser = new Parser({
  customFields: {
    item: [['content:encoded', 'contentEncoded']],
  }
});

const SOURCES_DIR = path.join(__dirname, '../data/sources');
// We don't need local FEEDS/ITEMS dirs anymore, but we read SOURCES locally.

const ALLOWED_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "li", "strong", "em", "a", "br", "div", "img", "span"];
const ALLOWED_ATTRIBUTES = { "a": ["href", "rel", "target"], "img": ["loading", "src", "alt", "title"], "span": ["class", "style"] };

function getHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').substring(0, 12);
}

function cleanHtml(html) {
    if (!html) return '';
    return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttributes: ALLOWED_ATTRIBUTES });
}

function wrapTitle(title, link) {
    const parts = title.split(" — ");
    let html = `<h1><a href="${link}" target="_blank">${parts[0]}</a></h1>`;
    for (let i = 1; i < parts.length; i++) html += `<h2>${parts[i]}</h2>`;
    return html;
}

function prettifyItem(item, sourceHash) {
    item.description = cleanHtml(item.description || '');
    item.title = wrapTitle(item.title || 'No Title', item.link || '#');
    item.source = sourceHash; 
    item.category = '';
    return item;
}

async function uploadToR2(key, data, contentType = 'application/json') {
    try {
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: JSON.stringify(data, null, 2),
            ContentType: contentType,
            CacheControl: 'public, max-age=3600' // cache for 1 hour
        }));
        // console.log(`  ^ Uploaded ${key}`);
    } catch (e) {
        console.error(`  !! Upload Failed ${key}: ${e.message}`);
    }
}

async function fetchFeed(url, etag, lastModified) {
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (response.status === 304) return { modified: false };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const xml = await response.text();
        return { modified: true, xml, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    } catch (e) {
        return { modified: false, error: e.message };
    }
}

async function main() {
    if (!fs.existsSync(SOURCES_DIR)) {
        console.error("No sources directory found.");
        process.exit(0);
    }

    const sourceFiles = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));
    console.log(`Ingesting ${sourceFiles.length} sources to R2...`);

    for (const file of sourceFiles) {
        const sourcePath = path.join(SOURCES_DIR, file);
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const sourceHash = file.replace('.json', '');
        
        const feedUrl = Buffer.from(source.u, 'base64').toString('utf8');

        try {
            const result = await fetchFeed(feedUrl, source.etag, source.lastModified);
            if (result.modified) {
                console.log(`  -> Processing ${sourceHash}...`);
                const feed = await parser.parseString(result.xml);
                const manifest = [];

                const uploadPromises = [];

                for (const item of feed.items) {
                    const guid = item.guid || item.link;
                    const itemHash = getHash(guid);
                    manifest.push({ g: guid, h: itemHash });

                    const processed = prettifyItem({
                        guid,
                        title: item.title,
                        link: item.link,
                        pubDate: item.pubDate,
                        description: item.contentEncoded || item.content || item.summary || item.description,
                        timestamp: Date.parse(item.pubDate) || Date.now(),
                    }, sourceHash);
                    
                    // Upload item to R2
                    uploadPromises.push(uploadToR2(`items/${sourceHash}/${itemHash}.json`, processed));
                }
                
                // Upload manifest to R2
                uploadPromises.push(uploadToR2(`feeds/${sourceHash}.json`, manifest));

                await Promise.all(uploadPromises);

                // Update local metadata (committed to git)
                source.etag = result.etag || "";
                source.lastModified = result.lastModified || "";
                fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
            }
        } catch (err) {
            console.error(`  !! Error ${sourceHash}: ${err.message}`);
        }
    }
    console.log('Ingestion complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
