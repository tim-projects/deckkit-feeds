const BaseIngestor = require('./BaseIngestor');

class XIngestor extends BaseIngestor {
    constructor(s3Client, bucketName, clientBucketName) {
        super(s3Client, bucketName);
        this.clientBucketName = clientBucketName;
    }

    async process(source, sourceHash, feedUrl) {
        console.error(`  !! X.com ingestion not yet implemented for: ${feedUrl}`);
        return { success: false, error: 'X.com ingestion not implemented' };
    }
}

module.exports = XIngestor;
