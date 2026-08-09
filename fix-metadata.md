# Plan: deckkit-feeds Repo — Write Manifests to feeds.deckk.it R2

## Context

The `deckkit-feeds` repo currently writes manifests to its own `deckkit-feeds` R2 bucket. The `not-the-news` client reads from `feeds.deckk.it` R2 bucket. These are different buckets, so manifests in `deckkit-feeds` are invisible to the client.

The client uses the manifest's HTTP status to decide whether to call `/api/refresh`:
- 200 → feed exists → fetch items
- 404 → feed missing → call `/api/refresh`

This is ambiguous: a 404 could mean "never ingested" or "ingested but broken." The fix is to ensure manifests always exist in `feeds.deckk.it` R2 (even empty arrays for broken feeds), so 404 unambiguously means "never ingested."

No cleanup is needed: an empty array `[]` is a few bytes in R2 and persists as the broken signal indefinitely.

## Changes

### 1. `lib/ingestors/RSSIngestor.js`

Modify `process()` to write manifests to `feeds.deckk.it` R2 in all cases:

- **Successful ingestion**: write the manifest array to `feeds/{hash}.json` in the `feeds.deckk.it` bucket
- **Fetch error (broken feed)**: write an empty array `[]` to `feeds/{hash}.json` in the `feeds.deckk.it` bucket
- **304 Not Modified**: skip writing (manifest already exists)

The ingestor uses the same S3 client for both buckets. Specify `Bucket: 'feeds.deckk.it'` in the `PutObjectCommand` for the client-facing bucket.

### 2. `scripts/ingest-rss.js`

No structural changes needed beyond passing `CLIENT_BUCKET_NAME` to the ingestor factory. The source file already tracks `brokenSince` and `lastError` for debugging, but no cleanup logic is required.

## Validation

1. Verify manifests appear in `feeds.deckk.it` R2 after successful ingestion
2. Verify broken feeds produce empty-array manifests (`[]`) in `feeds.deckk.it`
3. Verify the `deckkit-feeds` bucket still receives manifests (no regression)
4. Run `node scripts/ingest-rss.js` locally and verify R2 output
