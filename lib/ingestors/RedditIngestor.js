const RSSIngestor = require('./RSSIngestor');

class RedditIngestor extends RSSIngestor {
    constructor(s3Client, bucketName) {
        super(s3Client, bucketName);
        this.redditUser = process.env.REDDIT_USER;
        this.redditFeed = process.env.REDDIT_FEED;
    }

    async process(source, sourceHash, feedUrl) {
        if (this.redditUser && this.redditFeed) {
            try {
                const url = new URL(feedUrl);
                url.searchParams.set('user', this.redditUser);
                url.searchParams.set('feed', this.redditFeed);
                feedUrl = url.toString();
                console.log(`  -> Appending Reddit auth parameters to ${sourceHash}`);
            } catch (e) {
                console.warn(`  !! Failed to parse URL ${feedUrl} for ${sourceHash}: ${e.message}`);
            }
        } else {
            console.warn(`  !! REDDIT_USER or REDDIT_FEED missing. Proceeding without authentication for ${sourceHash}`);
        }

        return super.process(source, sourceHash, feedUrl);
    }
}

module.exports = RedditIngestor;
