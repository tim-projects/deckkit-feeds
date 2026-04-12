const RSSIngestor = require('./RSSIngestor');

class XIngestor extends RSSIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
        // Using a reliable nitter instance as a bridge. 
        // We could also rotate instances if one fails.
        this.nitterInstance = 'https://nitter.privacydev.net';
    }

    getUsername(url) {
        const parts = url.replace(/\/$/, '').split('/');
        return parts[parts.length - 1];
    }

    async process(source, sourceHash, feedUrl) {
        const username = this.getUsername(feedUrl);
        if (!username) {
            return { success: false, error: 'Could not extract X username from URL' };
        }

        const nitterRssUrl = `${this.nitterInstance}/${username}/rss`;
        console.log(`  -> Mapping X user ${username} to Nitter RSS: ${nitterRssUrl}`);

        // We use the same RSS processing logic, but with the Nitter RSS URL.
        // We pass the original source metadata (etag/lastModified) to the fetch.
        return super.process(source, sourceHash, nitterRssUrl);
    }
}

module.exports = XIngestor;
