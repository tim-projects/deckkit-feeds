const Parser = require('rss-parser');
const BaseIngestor = require('./BaseIngestor');

class XIngestor extends BaseIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
        this.parser = new Parser({
            customFields: {
                item: [['content:encoded', 'contentEncoded']],
            }
        });
        this.rsshubBaseUrl = process.env.RSSHUB_BASE_URL || 'https://rsshub.app';
    }

    transformTwitterUrl(url) {
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
            if (!['x.com', 'twitter.com'].includes(hostname)) {
                return null;
            }
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            if (pathParts.length === 0) {
                return null;
            }
            const username = pathParts[0];
            if (!username) {
                return null;
            }
            return `${this.rsshubBaseUrl}/twitter/user/${username}`;
        } catch {
            return null;
        }
    }

    async fetch(url, etag, lastModified) {
        const rsshubUrl = this.transformTwitterUrl(url);
        if (!rsshubUrl) {
            return { modified: false, error: `Invalid Twitter/X URL: ${url}` };
        }

        const headers = {};
        if (etag) headers['If-None-Match'] = etag;
        if (lastModified) headers['If-Modified-Since'] = lastModified;
        try {
            const response = await fetch(rsshubUrl, { headers, signal: AbortSignal.timeout(15000) });
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
            const sanitizedXml = this.sanitizeXml(result.xml);
            const feed = await this.parser.parseString(sanitizedXml);
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
            return { success: true, skip: true };
        }
    }
}

module.exports = XIngestor;
