const BaseIngestor = require('./BaseIngestor');

class XIngestor extends BaseIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
    }

    async process(source, sourceHash, feedUrl) {
        console.error(`  !! X.com ingestion not yet implemented for: ${feedUrl}`);
        return { success: false, error: 'X.com ingestion not implemented' };
    }
}

module.exports = XIngestor;
