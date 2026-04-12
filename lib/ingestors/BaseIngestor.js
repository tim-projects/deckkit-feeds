const crypto = require('crypto');
const sanitizeHtml = require('sanitize-html');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

class BaseIngestor {
    constructor(s3Client, bucketName) {
        this.s3 = s3Client;
        this.bucketName = bucketName;
        this.ALLOWED_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "li", "strong", "em", "a", "br", "div", "img", "span"];
        this.ALLOWED_ATTRIBUTES = { "a": ["href", "rel", "target"], "img": ["loading", "src", "alt", "title"], "span": ["class", "style"] };
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
        return item;
    }

    async uploadToR2(key, data, contentType = 'application/json') {
        try {
            await this.s3.send(new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: JSON.stringify(data, null, 2),
                ContentType: contentType,
                CacheControl: 'public, max-age=3600'
            }));
        } catch (e) {
            console.error(`  !! Upload Failed ${key}: ${e.message}`);
            throw e; // Rethrow to handle in run()
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
        // This will be overridden or implemented in concrete classes if they share a common flow.
        // For now, RSSIngestor will implement its own logic in run() or process().
        return this.process(source, sourceHash, feedUrl);
    }
}

module.exports = BaseIngestor;
