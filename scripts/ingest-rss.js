const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Parser = require('rss-parser');
const sanitizeHtml = require('sanitize-html');

const parser = new Parser({
  customFields: {
    item: [['content:encoded', 'contentEncoded']],
  }
});

const SOURCES_DIR = path.join(__dirname, '../data/sources');
const FEEDS_DIR = path.join(__dirname, '../feeds');
const ITEMS_ROOT = path.join(__dirname, '../items');

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
    // We strip all branding metadata to maintain feed anonymity in the public repo
    const domain = new URL(item.link || 'https://localhost').hostname.replace(/^www\./, '');
    
    // Minimal processing to avoid identifiable strings
    if (domain.includes('news.ycombinator.com') || domain.includes('hnrss.org')) {
        item.title = (item.title || '').replace(' | Hacker News', '');
    }

    item.description = cleanHtml(item.description || '');
    item.title = wrapTitle(item.title || 'No Title', item.link || '#');
    
    // Force source to be the hash, not a name
    item.source = sourceHash; 
    item.category = '';
    return item;
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
    [FEEDS_DIR, ITEMS_ROOT, SOURCES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

    const sourceFiles = fs.readdirSync(SOURCES_DIR).filter(f => f.endsWith('.json'));
    console.log(`Ingesting ${sourceFiles.length} sources...`);

    for (const file of sourceFiles) {
        const sourcePath = path.join(SOURCES_DIR, file);
        const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const sourceHash = file.replace('.json', '');
        
        // Decode the obfuscated URL
        const feedUrl = Buffer.from(source.u, 'base64').toString('utf8');

        const itemDir = path.join(ITEMS_ROOT, sourceHash);
        if (!fs.existsSync(itemDir)) fs.mkdirSync(itemDir, { recursive: true });

        try {
            const result = await fetchFeed(feedUrl, source.etag, source.lastModified);
            if (result.modified) {
                console.log(`  -> Syncing ${sourceHash}...`);
                const feed = await parser.parseString(result.xml);
                const manifest = [];

                for (const item of feed.items) {
                    const guid = item.guid || item.link;
                    const itemHash = getHash(guid);
                    manifest.push({ g: guid, h: itemHash });

                    const itemPath = path.join(itemDir, `${itemHash}.json`);
                    if (!fs.existsSync(itemPath)) {
                        const processed = prettifyItem({
                            guid,
                            title: item.title,
                            link: item.link,
                            pubDate: item.pubDate,
                            description: item.contentEncoded || item.content || item.summary || item.description,
                            timestamp: Date.parse(item.pubDate) || Date.now(),
                        }, sourceHash);
                        fs.writeFileSync(itemPath, JSON.stringify(processed, null, 2));
                    }
                }

                // Write Feed Manifest
                fs.writeFileSync(path.join(FEEDS_DIR, `${sourceHash}.json`), JSON.stringify(manifest, null, 2));

                // Update metadata
                source.etag = result.etag || "";
                source.lastModified = result.lastModified || "";
                fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2));
            }
        } catch (err) {
            console.error(`  !! Error ${sourceHash}: ${err.message}`);
        }
    }
    
    // NOTE: index.json is removed for privacy. 
    // The client generates the sourceHash from the URL.
    fs.writeFileSync(path.join(ITEMS_ROOT, '.nojekyll'), ''); 
    console.log('Ingestion complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
