// Train a new Soul character from a folder of photos.
//
//   node scripts/create-character.mjs --name "Mia" --images ./photos-of-mia
//
// Flags:
//   --name <name>      required — the character's name
//   --images <path>    required — folder containing 5-20 photos (jpg/png/webp) of the SAME person
//   --cinematic        train Soul Cinematic instead of Soul 2.0
//
// Training takes several minutes and costs credits; this script waits until done.
// Prints RESULT:{...} JSON on the last line.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { hf, getCredits } from "./lib.mjs";

function parseArgs(argv) {
  const args = { cinematic: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") args.name = argv[++i];
    else if (a === "--images") args.images = argv[++i];
    else if (a === "--cinematic") args.cinematic = true;
  }
  return args;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

const args = parseArgs(process.argv);
if (!args.name) fail("--name is required");
if (!args.images) fail("--images <folder> is required");
if (!existsSync(args.images)) fail(`folder not found: ${args.images}`);

const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
let files = [];
if (statSync(args.images).isDirectory()) {
  files = readdirSync(args.images)
    .filter((f) => IMG_EXT.has(extname(f).toLowerCase()))
    .map((f) => join(args.images, f));
} else {
  files = [args.images];
}

if (files.length < 5) {
  fail(`Soul training needs 5-20 photos of the same person; found ${files.length} in ${args.images}. Add more photos (10+ from different angles works best).`);
}
if (files.length > 20) {
  console.log(`Found ${files.length} photos — using the first 20.`);
  files = files.slice(0, 20);
}

const credits = await getCredits();
if (credits === null) fail("Not logged in to Higgsfield. Run: higgsfield auth login");
console.log(`Credits: ${credits}`);
console.log(`Training "${args.name}" (${args.cinematic ? "Soul Cinematic" : "Soul 2.0"}) on ${files.length} photos...`);
console.log("Uploading and starting training — this takes several minutes.");

const createArgs = ["soul-id", "create", "--name", args.name, args.cinematic ? "--soul-cinematic" : "--soul-2"];
for (const f of files) createArgs.push("--image", f);
createArgs.push("--json");

const createdRaw = await hf(createArgs, { timeoutMs: 30 * 60 * 1000 });
let soulId = null;
try {
  const parsed = JSON.parse(createdRaw);
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  soulId = obj.id || obj.soul_id || obj.reference_id || null;
} catch { /* fall through to regex */ }
if (!soulId) {
  const m = createdRaw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  soulId = m ? m[0] : null;
}
if (!soulId) fail("training started but could not read the character id from the CLI output: " + createdRaw.slice(0, 200));

console.log(`Training job: ${soulId} — waiting for completion...`);
const waited = await hf(["soul-id", "wait", soulId], { timeoutMs: 60 * 60 * 1000 });
console.log(waited);

const creditsAfter = await getCredits();
console.log(`Character "${args.name}" is ready. Use it with:`);
console.log(`  node scripts/make-videos.mjs --character "${args.name}" --count 1`);
console.log("RESULT:" + JSON.stringify({
  ok: true,
  name: args.name,
  soul_id: soulId,
  photos_used: files.length,
  credits_spent: credits !== null && creditsAfter !== null ? Math.round((credits - creditsAfter) * 100) / 100 : null,
}));
