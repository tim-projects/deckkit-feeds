const Parser = require('rss-parser');
const BaseIngestor = require('./BaseIngestor');

const FEED_USER_AGENT = 'Mozilla/5.0 (compatible; DeckkitFeeds/1.0; +https://feeds.deckk.it)';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

class RSSIngestor extends BaseIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
        this.parser = new Parser({
            customFields: {
                item: [['content:encoded', 'contentEncoded']],
            }
        });
    }

    async fetch(url, etag, lastModified, options = {}) {
        const headers = { 'User-Agent': FEED_USER_AGENT };
        if (!options.force) {
            if (etag) headers['If-None-Match'] = etag;
            if (lastModified) headers['If-Modified-Since'] = lastModified;
        }
        const maxRetries = options.force ? MAX_RETRIES : 0;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
                if (response.status === 304) return { modified: false };
                if (!response.ok) {
                    if (attempt < maxRetries) {
                        console.log(`  -> HTTP ${response.status}, retrying (${attempt + 1}/${maxRetries})...`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
                        continue;
                    }
                    throw new Error(`HTTP ${response.status}`);
                }
                const xml = await response.text();
                return { modified: true, xml, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
            } catch (e) {
                if (attempt < maxRetries && (e.name === 'TimeoutError' || e.name === 'AbortError' || /500|404/.test(e.message))) {
                    console.log(`  -> ${e.message}, retrying (${attempt + 1}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
                    continue;
                }
                return { modified: false, error: e.message };
            }
        }
        return { modified: false, error: 'Max retries exceeded' };
    }

    isRedditUrl(url) {
        try {
            const hostname = new URL(url).hostname.replace(/^www\./, '');
            return hostname === 'old.reddit.com' || hostname === 'reddit.com';
        } catch {
            return false;
        }
    }

    async process(source, sourceHash, feedUrl, options = {}) {
        const result = await this.fetch(feedUrl, source.etag, source.lastModified, options);
        if (result.modified) {
            console.log(`  -> Processing ${sourceHash}...`);
            const sanitizedXml = this.sanitizeXml(result.xml);
            const feed = await this.parser.parseString(sanitizedXml);
            const manifest = [];
            const uploadPromises = [];
            const isReddit = this.isRedditUrl(feedUrl);

            for (const item of feed.items) {
                const guid = item.guid || item.link;
                const itemHash = this.getHash(guid);
                manifest.push({ g: guid, h: itemHash });
                const processed = this.prettifyItem({
                    guid,
                    title: item.title,
                    link: item.link,
                    pubDate: item.pubDate,
                    description: item.contentEncoded || item.content || item.summary || item.description,
                    timestamp: Date.parse(item.pubDate) || Date.now(),
                }, sourceHash, { isReddit });
                uploadPromises.push(this.uploadToR2(`items/${sourceHash}/${itemHash}.json`, processed));
            }
            uploadPromises.push(this.uploadToR2(`feeds/${sourceHash}.json`, manifest));
            await Promise.all(uploadPromises);
            
            return {
                success: true,
                etag: result.etag || "",
                lastModified: result.lastModified || "",
                manifest
            };
        } else if (result.error) {
            return { success: false, error: result.error };
        } else {
            return { success: true, skip: true }; // Not modified
        }
    }
}

module.exports = RSSIngestor;
