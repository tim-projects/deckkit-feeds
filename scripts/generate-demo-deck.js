const fs = require("fs");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = "deckkit-feeds";

if (!ACCOUNT_ID || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error("Missing R2 credentials. Exiting.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

const POPULARITY_PATH = path.join(__dirname, "../data/popularity.json");
const SOURCES_DIR = path.join(__dirname, "../data/sources");

const HOUR_IN_MS = 1000 * 60 * 60;
const IMAGE_BOOST = 6 * HOUR_IN_MS;
const DIVERSITY_PENALTY = 4 * HOUR_IN_MS;

async function fetchManifest(sourceHash) {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `feeds/${sourceHash}.json`,
      }),
    );
    const body = await result.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    if (e.name !== "NoSuchKey")
      console.error(`Failed to fetch manifest ${sourceHash}: ${e.message}`);
    return null;
  }
}

async function fetchItem(sourceHash, itemHash) {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `items/${sourceHash}/${itemHash}.json`,
      }),
    );
    const body = await result.Body.transformToString();
    return JSON.parse(body);
  } catch (e) {
    if (e.name !== "NoSuchKey")
      console.error(
        `Failed to fetch item ${sourceHash}/${itemHash}: ${e.message}`,
      );
    return null;
  }
}

async function fetchItemsInParallel(items, concurrency = 20) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ sourceHash, h }) => {
        const item = await fetchItem(sourceHash, h);
        return { item, sourceHash, itemHash: h };
      }),
    );
    results.push(...batchResults);
  }
  return results;
}

async function generate() {
  const args = process.argv.slice(2);
  const outputFileIndex = args.indexOf("--output-file");
  const outputFile =
    outputFileIndex !== -1 && args[outputFileIndex + 1]
      ? args[outputFileIndex + 1]
      : null;

  console.log("Starting Demo Deck Generation...");

  if (!fs.existsSync(POPULARITY_PATH)) {
    console.error("Popularity map not found. Skipping.");
    return;
  }

  const popularity = JSON.parse(fs.readFileSync(POPULARITY_PATH, "utf8"));
  const feedPopularity = popularity.feeds || {};
  const itemPopularity = popularity.items || {};

  const allItems = [];
  const sourceFiles = fs
    .readdirSync(SOURCES_DIR)
    .filter((f) => f.endsWith(".json"));

  console.log(`Processing ${sourceFiles.length} sources...`);

  for (const file of sourceFiles) {
    const sourceHash = file.replace(".json", "");
    const manifest = await fetchManifest(sourceHash);

    if (!manifest) continue;

    const subCount = feedPopularity[sourceHash] || 0;
    const subBoost = Math.log10(subCount + 1) * 12 * HOUR_IN_MS;

    console.log(
      `  Fetching items from ${sourceHash} (${manifest.length} items)...`,
    );

    const itemsWithHashes = manifest.map((entry) => ({ ...entry, sourceHash }));
    const fetched = await fetchItemsInParallel(itemsWithHashes, 20);

    for (const { item, sourceHash: sh, itemHash } of fetched) {
      if (!item) continue;

      const starCount = itemPopularity[itemHash] || 0;
      const starBoost = starCount * 6 * HOUR_IN_MS;

      let score = new Date(item.pubDate || item.published).getTime();
      if (item.image) score += IMAGE_BOOST;
      score += subBoost;
      score += starBoost;

      allItems.push({ ...item, score, sourceHash: sh });
    }
  }

  // Sort and Apply Diversity Penalty
  allItems.sort((a, b) => b.score - a.score);

  // Deduplicate by GUID - keep first occurrence (highest score)
  const seenGuids = new Set();
  const dedupedItems = [];
  for (const item of allItems) {
    const guid = item.guid || item.link || "";
    if (!seenGuids.has(guid)) {
      seenGuids.add(guid);
      dedupedItems.push(item);
    }
  }

  console.log(
    `Deduplicated from ${allItems.length} to ${dedupedItems.length} items by GUID.`,
  );

  const sourceCounts = {};
  const finalItems = [];

  for (const item of dedupedItems) {
    if (finalItems.length >= 10) break;

    const source = item["deckkit:source"] || item.sourceHash;
    const count = sourceCounts[source] || 0;
    const penalty = count * DIVERSITY_PENALTY;

    item.score -= penalty;
    sourceCounts[source] = count + 1;
    finalItems.push(item);
  }

  // Re-sort final top 10
  finalItems.sort((a, b) => b.score - a.score);

  const payload = JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      items: finalItems.map(({ score, sourceHash, ...rest }) => rest),
    },
    null,
    2,
  );

  console.log(`Generated demo deck with ${finalItems.length} items.`);

  if (outputFile) {
    fs.writeFileSync(outputFile, payload);
    console.log(`Wrote demo deck to ${outputFile}`);
  } else {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: "demo-deck.json",
        Body: payload,
        ContentType: "application/json",
        CacheControl: "public, max-age=300",
      }),
    );
    console.log("Uploaded demo-deck.json to R2.");
  }
}

generate().catch(console.error);
