const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const { PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

class BaseIngestor {
    constructor(s3Client, bucketName) {
        this.s3 = s3Client;
        this.bucketName = bucketName;
        this.ALLOWED_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "li", "strong", "em", "a", "br", "div", "img", "span"];
        this.ALLOWED_ATTRIBUTES = { "a": ["href", "rel", "target"], "img": ["loading", "src", "alt", "title"], "span": ["class", "style"] };
        this.DEFAULT_ICON_URL = 'https://deckk.it/images/favicon.svg';
        this.DEFAULT_ICON_KEY = 'assets/default-icon.svg';
    }

    getHash(text) {
        return crypto.createHash('sha256').update(text).digest('hex').substring(0, 12);
    }

    cleanHtml(html) {
        if (!html) return '';
        return sanitizeHtml(html, { allowedTags: this.ALLOWED_TAGS, allowedAttributes: this.ALLOWED_ATTRIBUTES });
    }

    wrapTitle(title, link) {
        const parts = title.split(" — ");
        let html = `<h1><a href="${link}" target="_blank">${parts[0]}</a></h1>`;
        for (let i = 1; i < parts.length; i++) html += `<h2>${parts[i]}</h2>`;
        return html;
    }

    prettifyItem(item, sourceHash) {
        item.description = this.cleanHtml(item.description || '');
        item.title = this.wrapTitle(item.title || 'No Title', item.link || '#');
        item.source = sourceHash; 
        item.category = '';
        // Use the default icon key if no image is provided.
        // DeckKit app can resolve this relative to the bucket or we can provide full URL if needed.
        item.icon = this.DEFAULT_ICON_KEY; 
        return item;
    }

    async uploadToR2(key, data, contentType = 'application/json') {
        try {
            const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
            await this.s3.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: body,
                ContentType: contentType,
                CacheControl: 'public, max-age=3600'
            }));
        } catch (e) {
            console.error(`  !! Upload Failed ${key}: ${e.message}`);
            throw e; 
        }
    }

    async ensureDefaultIcon() {
        try {
            await this.s3.send(new HeadObjectCommand({
                Bucket: this.bucketName,
                Key: this.DEFAULT_ICON_KEY
            }));
        } catch (e) {
            if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
                console.log(`  -> Downloading default icon from ${this.DEFAULT_ICON_URL}...`);
                try {
                    const response = await fetch(this.DEFAULT_ICON_URL);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const buffer = Buffer.from(await response.arrayBuffer());
                    await this.uploadToR2(this.DEFAULT_ICON_KEY, buffer, 'image/svg+xml');
                    console.log(`  -> Uploaded default icon to R2: ${this.DEFAULT_ICON_KEY}`);
                } catch (fetchErr) {
                    console.error(`  !! Failed to download default icon: ${fetchErr.message}`);
                }
            } else {
                console.error(`  !! Error checking for default icon: ${e.message}`);
            }
        }
    }

    /**
     * @abstract
     */
    async fetch(url, etag, lastModified) {
        throw new Error('fetch() must be implemented');
    }

    /**
     * @abstract
     */
    async process(source, sourceHash, feedUrl) {
        throw new Error('process() must be implemented');
    }

    async run(source, sourceHash, feedUrl) {
        // Ensure the default icon exists in the bucket at least once per runner execution (or per source if we want to be sure).
        // Since many sources run in parallel/sequence, we might want to do this once.
        // For simplicity, we check it here; HeadObject is cheap.
        await this.ensureDefaultIcon();
        return this.process(source, sourceHash, feedUrl);
    }
}

module.exports = BaseIngestor;
