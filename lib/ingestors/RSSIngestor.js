const Parser = require('rss-parser');
const BaseIngestor = require('./BaseIngestor');

class RSSIngestor extends BaseIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
        this.parser = new Parser({
            customFields: {
                item: [['content:encoded', 'contentEncoded']],
            }
        });
    }

    async fetch(url, etag, lastModified) {
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

    async process(source, sourceHash, feedUrl) {
        const result = await this.fetch(feedUrl, source.etag, source.lastModified);
        if (result.modified) {
            console.log(`  -> Processing ${sourceHash}...`);
            const feed = await this.parser.parseString(result.xml);
            const manifest = [];
            const uploadPromises = [];

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
                }, sourceHash);
                uploadPromises.push(this.uploadToR2(`items/${sourceHash}/${itemHash}.json`, processed));
            }
            uploadPromises.push(this.uploadToR2(`feeds/${sourceHash}.json`, manifest));
            await Promise.all(uploadPromises);
            
            return {
                success: true,
                etag: result.etag || "",
                lastModified: result.lastModified || ""
            };
        } else if (result.error) {
            return { success: false, error: result.error };
        } else {
            return { success: true, skip: true }; // Not modified
        }
    }
}

module.exports = RSSIngestor;
