const Parser = require('rss-parser');
const BaseIngestor = require('./BaseIngestor');
const { execFile } = require('child_process');

const FEED_USER_AGENT = 'Mozilla/5.0 (compatible; DeckkitFeeds/1.0; +https://feeds.deckk.it)';
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 3000;

class RSSIngestor extends BaseIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
        this.parser = new Parser({
            customFields: {
                item: [['content:encoded', 'contentEncoded']],
            }
        });
    }

    isYoutubeUrl(url) {
        try {
            const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
            return hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtu.be';
        } catch {
            return false;
        }
    }

    async fetchWithCurl(url) {
        return new Promise((resolve, reject) => {
            execFile('curl', [
                '-sS',
                '-L',
                '-A', FEED_USER_AGENT,
                '--max-time', '30',
                '--connect-timeout', '15',
                '-D', '-', // dump headers
                url
            ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`curl error: ${err.message}`));
                    return;
                }
                // curl with -D - dumps headers followed by body, separated by \r\n\r\n
                const blankLineIdx = stdout.indexOf('\r\n\r\n');
                let headerPart = '';
                let bodyPart = '';
                if (blankLineIdx !== -1) {
                    headerPart = stdout.substring(0, blankLineIdx);
                    bodyPart = stdout.substring(blankLineIdx + 4);
                } else {
                    const nlIdx = stdout.indexOf('\n\n');
                    if (nlIdx !== -1) {
                        headerPart = stdout.substring(0, nlIdx);
                        bodyPart = stdout.substring(nlIdx + 2);
                    } else {
                        bodyPart = stdout;
                    }
                }
                const headers = {};
                const statusLine = headerPart.split('\n')[0];
                const statusCode = parseInt(statusLine.match(/HTTP\/\d\.\d (\d+)/)?.[1] || '0');
                headerPart.split('\n').forEach(line => {
                    const [key, ...vals] = line.split(':');
                    if (key && vals.length) {
                        headers[key.trim().toLowerCase()] = vals.join(':').trim();
                    }
                });
                resolve({ statusCode, headers, body: bodyPart });
            });
        });
    }

    async fetch(url, etag, lastModified, options = {}) {
        const useCurl = this.isYoutubeUrl(url);
        const headers = { 'User-Agent': FEED_USER_AGENT };
        if (!options.force) {
            if (etag) headers['If-None-Match'] = etag;
            if (lastModified) headers['If-Modified-Since'] = lastModified;
        }
        const maxRetries = options.force ? MAX_RETRIES : 0;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                let response, xml, respEtag, respLastModified;
                if (useCurl) {
                    const curlResult = await this.fetchWithCurl(url);
                    response = { status: curlResult.statusCode, headers: curlResult.headers, text: () => Promise.resolve(curlResult.body) };
                    if (response.status === 304) return { modified: false };
                    if (response.status < 200 || response.status >= 400) {
                        if (attempt < maxRetries) {
                            console.log(`  -> HTTP ${response.status}, retrying (${attempt + 1}/${maxRetries})...`);
                            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
                            continue;
                        }
                        throw new Error(`HTTP ${response.status}`);
                    }
                    xml = curlResult.body;
                    respEtag = response.headers.etag;
                    respLastModified = response.headers['last-modified'];
                } else {
                    response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
                    if (response.status === 304) return { modified: false };
                    if (!response.ok) {
                        if (attempt < maxRetries) {
                            console.log(`  -> HTTP ${response.status}, retrying (${attempt + 1}/${maxRetries})...`);
                            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
                            continue;
                        }
                        throw new Error(`HTTP ${response.status}`);
                    }
                    xml = await response.text();
                    respEtag = response.headers.get('etag');
                    respLastModified = response.headers.get('last-modified');
                }
                return { modified: true, xml, etag: respEtag, lastModified: respLastModified };
            } catch (e) {
                if (attempt < maxRetries && (e.name === 'TimeoutError' || e.name === 'AbortError' || /500|404|curl error/.test(e.message))) {
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
