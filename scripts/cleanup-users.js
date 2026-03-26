const fs = require("fs");
const path = require("path");
const {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "deckkit-user-content-dev";
const R2_ENDPOINT = process.env.R2_ENDPOINT;

// Initialize Firebase Admin
const app = initializeApp({
  credential: cert({
    projectId: PROJECT_ID,
    privateKey: PRIVATE_KEY,
    clientEmail: CLIENT_EMAIL,
  }),
});

const db = getFirestore(app);

// Initialize R2 client
let s3 = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  s3 = new S3Client({
    region: "auto",
    endpoint:
      R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

async function cleanupUsers() {
  console.log("Starting user cleanup...");

  // Step 1: Anonymize users who have anonymizedAt but not yet processed
  console.log("[Step 1] Finding users to anonymize...");
  const toAnonymize = await db
    .collection("users")
    .where("data.anonymizedAt", "!=", null)
    .where("data._deletion.scheduledAt", "==", null)
    .get();

  if (!toAnonymize.empty) {
    console.log(`Found ${toAnonymize.size} users to anonymize.`);

    for (const doc of toAnonymize.docs) {
      const uid = doc.id;
      console.log(`Anonymizing user: ${uid}`);

      try {
        // Anonymize read/starred items - keep the records but remove personal association
        const subcollections = ["read", "starred"];
        for (const subcol of subcollections) {
          const subcolRef = db.collection(`users/${uid}/${subcol}`);
          const subcolDocs = await subcolRef.get();

          // Update all items to remove personal data but keep interaction
          const batch = db.batch();
          subcolDocs.forEach((d) => {
            batch.update(d.ref, {
              // Mark as anonymized but keep the read/starred timestamp for global stats
              anonymized: true,
              anonymizedAt: FieldValue.serverTimestamp(),
              originalGuid: d.data().guid, // Keep for global stats
            });
          });
          await batch.commit();
          console.log(`  Anonymized ${subcolDocs.size} ${subcol} items`);
        }

        // Mark user for scheduled deletion
        await db.doc(`users/${uid}/data/settings`).update({
          _deletion: {
            scheduledAt: FieldValue.serverTimestamp(),
            anonymized: true,
          },
        });
        console.log(`  Marked ${uid} for deletion`);
      } catch (e) {
        console.error(`  Failed to anonymize user ${uid}:`, e.message);
      }
    }
  } else {
    console.log("No users to anonymize.");
  }

  // Step 2: Delete users marked for deletion
  console.log("[Step 2] Finding users to delete...");
  const snapshot = await db
    .collection("users")
    .where("data._deletion.scheduledAt", "<", FieldValue.serverTimestamp())
    .get();

  if (snapshot.empty) {
    console.log("No users marked for deletion.");
    return;
  }

  console.log(`Found ${snapshot.size} users to delete.`);

  for (const doc of snapshot.docs) {
    const uid = doc.id;
    console.log(`Deleting user: ${uid}`);

    try {
      // Delete subcollections (read, starred, hidden)
      const subcollections = ["read", "starred", "hidden"];
      for (const subcol of subcollections) {
        const subcolRef = db.collection(`users/${uid}/${subcol}`);
        const subcolDocs = await subcolRef.get();

        const batch = db.batch();
        subcolDocs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        console.log(`  Deleted ${subcolDocs.size} items from ${subcol}`);
      }

      // Delete the user settings document
      await db.doc(`users/${uid}/data/settings`).delete();
      console.log("  Deleted settings document");

      // Delete R2 user content
      if (s3) {
        const listCommand = new ListObjectsV2Command({
          Bucket: R2_BUCKET_NAME,
          Prefix: `users/${uid}/`,
        });
        const objects = await s3.send(listCommand);

        if (objects.Contents && objects.Contents.length > 0) {
          for (const obj of objects.Contents) {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: obj.Key,
            });
            await s3.send(deleteCommand);
          }
          console.log(`  Deleted ${objects.Contents.length} objects from R2`);
        }
      }

      // Delete the user document itself
      await doc.ref.delete();
      console.log(`  Successfully deleted user: ${uid}`);
    } catch (e) {
      console.error(`  Failed to delete user ${uid}:`, e.message);
    }
  }

  console.log("User cleanup complete.");
}

cleanupUsers().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
