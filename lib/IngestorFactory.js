const RSSIngestor = require('./ingestors/RSSIngestor');
const XIngestor = require('./ingestors/XIngestor');

class IngestorFactory {
    static getIngestor(url, s3Client, bucketName) {
        if (url.includes('x.com') || url.includes('twitter.com')) {
            return new XIngestor(s3Client, bucketName);
        }
        
        // Default to RSS
        return new RSSIngestor(s3Client, bucketName);
    }
}

module.exports = IngestorFactory;
