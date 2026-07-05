// Submit character videos: outfit prompt -> Soul 2.0 image -> Kling 3.0
// Motion Control -> MP4. This script only SUBMITS jobs — it never waits for
// renders, so it always exits within a minute or two.
//
// Collect the results with check.mjs (run it every ~2 minutes until all_done):
//
//   node scripts/make-videos.mjs --character "Mia Lin" --count 1
//   node scripts/check.mjs
//
// Flags:
//   --character <name>   required; fuzzy-matched against trained Soul characters
//   --count <n>          default 1, capped by config.max_videos_per_request
//   --clip <path>        use this motion clip for every video (default: random per video)
//   --prompt <text>      use this prompt for every video (default: random outfit prompt)
//   --extra-prompt <t>   appended to every prompt (steer scene/lighting/vibe on top of the random outfit)
//   --mode std|pro       Kling quality mode (default from config)
//   --force              submit even though this character already has pending videos
//   --dry-run            show the plan without spending credits
//
// Prints human-readable progress; the last line is machine-readable JSON (RESULT:{...}).

import {
  loadConfig, ensureDirs, hf, parseJob, getCredits, resolveCharacter,
  fetchOutfitPrompts, pickClip, listClips, slug, appendFailure,
  classifyFailure, readQueue, writeQueue,
} from "./lib.mjs";
import { basename } from "node:path";
import { existsSync } from "node:fs";

const CHECK_CMD = "node scripts/check.mjs";

function parseArgs(argv) {
  const args = { count: 1, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--character") args.character = argv[++i];
    else if (a === "--count") args.count = parseInt(argv[++i], 10) || 1;
    else if (a === "--clip") args.clip = argv[++i];
    else if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--extra-prompt") args.extraPrompt = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

const args = parseArgs(process.argv);
if (!args.character) fail("--character is required, e.g. --character \"Mia Lin\"");

const cfg = loadConfig();
ensureDirs(cfg);
const mode = args.mode || cfg.mode || "std";
const count = Math.min(Math.max(args.count, 1), cfg.max_videos_per_request || 10);
if (args.count > count) {
  console.log(`Note: capped at ${count} videos per request (config.max_videos_per_request).`);
}

// --- credits guard ---
const creditsStart = await getCredits();
if (creditsStart === null) {
  fail("Not logged in to Higgsfield. The USER must run: higgsfield auth login");
}
if (creditsStart < (cfg.credit_floor || 0)) {
  fail(`Credit balance ${creditsStart} is below the safety floor of ${cfg.credit_floor}. Top up or lower credit_floor in config.json.`);
}
console.log(`Credits: ${creditsStart}`);

// --- character ---
const { chosen, alternates, all } = await resolveCharacter(args.character);
if (!chosen) {
  fail(`No trained character matches "${args.character}". Available: ${all.map((c) => c.name).join(", ") || "(none — create one with create-character)"}`);
}
console.log(`Character: ${chosen.name} (${chosen.id})`);
if (alternates.length) {
  console.log(`  (also matched: ${alternates.map((c) => c.name).join(", ")} — using closest match)`);
}

// --- double-submit guard (the classic way agents waste credits) ---
const queue = readQueue(cfg);
if (!args.dryRun && !args.force) {
  const pendingSame = queue.filter((q) => q.character === chosen.name).length;
  if (pendingSame > 0) {
    fail(`${chosen.name} already has ${pendingSame} pending video(s). They are NOT lost — collect them with: ${CHECK_CMD}. Only if you really want ADDITIONAL videos, re-run with --force.`);
  }
}

// --- motion clips ---
if (args.clip && !existsSync(args.clip)) fail(`Clip not found: ${args.clip}`);
if (!args.clip && listClips(cfg, chosen.name).length === 0) {
  fail(`No motion clips found. Add .mp4/.mov/.webm files to: ${cfg.motion_dir} (or a "${chosen.name}" subfolder there for character-specific clips)`);
}

// --- prompts ---
let prompts;
let promptSource = "custom";
if (args.prompt) {
  prompts = Array(count).fill(args.prompt);
} else {
  const fetched = await fetchOutfitPrompts(cfg, count);
  prompts = fetched.prompts;
  promptSource = fetched.source;
  console.log(`Outfit prompts: ${count} fetched from ${promptSource}`);
}
const extra = args.extraPrompt || cfg.extra_prompt || "";
if (extra) {
  prompts = prompts.map((p) => `${p}\n\n${extra}`);
  console.log(`Extra prompt applied: "${extra}"`);
}

// --- dry run stops here ---
if (args.dryRun) {
  const plan = prompts.map((p, i) => ({
    video: i + 1,
    clip: basename(args.clip || pickClip(cfg, chosen.name) || "?"),
    prompt_preview: p.slice(0, 120).replace(/\s+/g, " ") + (p.length > 120 ? "..." : ""),
  }));
  for (const row of plan) console.log(`  [${row.video}] clip=${row.clip} prompt="${row.prompt_preview}"`);
  console.log(`Estimated image cost: ${(0.12 * count).toFixed(2)} credits. Video cost depends on clip length/mode and is billed by Higgsfield per job.`);
  console.log("RESULT:" + JSON.stringify({
    ok: true, dry_run: true, character: chosen.name, videos_planned: count,
    prompt_source: promptSource,
    next: "Submit for real by re-running without --dry-run.",
  }));
  process.exit(0);
}

// --- submit (upload clip once per file, then queue one Soul image job per video) ---
// second-resolution stamp so labels (and their image/video files) can never
// collide across back-to-back submits
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");
const uploadCache = new Map(); // clip path -> higgsfield upload id (avoid re-uploading)
const queuedItems = [];
const failures = [];
let failed = 0;

for (let i = 0; i < count; i++) {
  const label = `${slug(chosen.name)}_${stamp}_${i + 1}`;
  const tag = `[${i + 1}/${count}]`;
  let stage = "upload";
  let clipPath = null;
  try {
    // 1) motion clip upload first — if it fails we haven't spent image credits
    clipPath = args.clip || pickClip(cfg, chosen.name);
    let clipRef = uploadCache.get(clipPath);
    if (!clipRef) {
      console.log(`${tag} uploading motion clip ${basename(clipPath)}...`);
      const up = JSON.parse(await hf(["upload", "create", clipPath, "--json"], { timeoutMs: 10 * 60 * 1000 }));
      const upObj = Array.isArray(up) ? up[0] : up;
      if (!upObj?.id) throw new Error("clip upload returned no id");
      clipRef = upObj.id;
      uploadCache.set(clipPath, clipRef);
    }

    // 2) submit the Soul 2.0 image job — no --wait, check.mjs takes it from here
    stage = "image";
    console.log(`${tag} submitting Soul 2.0 image of ${chosen.name}...`);
    const soul = parseJob(await hf([
      "generate", "create", "text2image_soul_v2",
      "--prompt", prompts[i],
      "--soul-id", chosen.id,
      "--aspect_ratio", cfg.aspect_ratio || "9:16",
      "--quality", cfg.quality || "2k",
      "--json",
    ], { timeoutMs: 3 * 60 * 1000 }));
    if (!soul?.id) throw new Error("image submit returned no job id");

    queue.push({
      id: label,
      character: chosen.name,
      stage: "image", // image -> ready -> video (check.mjs advances it)
      soul_job: soul.id,
      kling_job: null,
      clip: clipPath,
      clip_upload_id: clipRef,
      mode,
      prompt: prompts[i].slice(0, 300),
      prompt_source: promptSource,
      image_file: null,
      created: new Date().toISOString(),
    });
    queuedItems.push(label);
    console.log(`${tag} queued (image job ${soul.id})`);
  } catch (e) {
    failed++;
    const message = String(e?.message || e);
    const errorType = classifyFailure(message, null);
    const failure = {
      time: new Date().toISOString(),
      character: chosen.name,
      index: i + 1,
      stage,
      error_type: errorType,
      status: null,
      message,
      soul_job: null,
      kling_job: null,
      job_type: null,
      result_url: null,
      image: null,
      clip: clipPath ? basename(clipPath) : null,
      retryable: !["content_blocked", "auth", "credits"].includes(errorType),
    };
    failures.push(failure);
    appendFailure(cfg, failure);
    console.error(`${tag} FAILED to submit: ${message}`);
  }
}

writeQueue(cfg, queue);

const next = queuedItems.length
  ? `Run every ~2 minutes until RESULT.all_done is true: ${CHECK_CMD}`
  : "Nothing was submitted — fix the error above and try again.";
console.log(`Submitted ${queuedItems.length}/${count} video job(s).` + (queuedItems.length ? ` Collect them with: ${CHECK_CMD}` : ""));
console.log("RESULT:" + JSON.stringify({
  ok: failed === 0,
  character: chosen.name,
  submitted: queuedItems.length,
  queued: queuedItems,
  failed,
  failures,
  next,
}));
process.exit(failed > 0 && queuedItems.length === 0 ? 1 : 0);
