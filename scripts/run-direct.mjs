// DIRECT METHOD ("second method"): the RUN ME.bat process as one blocking
// command. For each video, start to finish in sequence:
//   outfit prompt -> Soul 2.0 image (--wait) -> upload motion clip ->
//   Kling 3.0 Motion Control (--wait 30m) -> download MP4 -> manifest
//
// Use ONLY when the user explicitly asks for the direct/second method.
// This command BLOCKS 5-20+ minutes PER VIDEO while Higgsfield renders.
// Run it with the longest timeout available and never kill it.
//
//   node scripts/run-direct.mjs --character "Mia Lin" --count 2
//
// Flags:
//   --character <name>   required; fuzzy-matched against trained Soul characters
//   --count <n>          default 1, capped by config.max_videos_per_request
//   --clip <path>        use this motion clip for every video (default: random per video)
//   --prompt <text>      use this prompt for every video (default: random outfit prompt)
//   --extra-prompt <t>   appended to every prompt
//   --mode std|pro       Kling quality mode (default from config)
//
// Crash-safe: progress is mirrored into output/queue.json, so if this run is
// killed at any point, `node scripts/check.mjs` recovers the in-flight videos
// (do not run check.mjs WHILE this is running — only after it stops).
//
// Prints step-by-step progress; the last line is RESULT:{...}.

import {
  loadConfig, ensureDirs, hf, parseJob, parseCreate, getCredits,
  resolveCharacter, fetchOutfitPrompts, pickClip, listClips, slug,
  appendManifest, appendFailure, classifyFailure, readQueue, writeQueue,
  download,
} from "./lib.mjs";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const args = { count: 1 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--character") args.character = argv[++i];
    else if (a === "--count") args.count = parseInt(argv[++i], 10) || 1;
    else if (a === "--clip") args.clip = argv[++i];
    else if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--extra-prompt") args.extraPrompt = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
  }
  return args;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// queue mirroring (read-modify-write so a crash leaves recoverable state)
function queueUpsert(cfg, item) {
  const q = readQueue(cfg).filter((x) => x.id !== item.id);
  q.push(item);
  writeQueue(cfg, q);
}
function queueRemove(cfg, id) {
  writeQueue(cfg, readQueue(cfg).filter((x) => x.id !== id));
}

const args = parseArgs(process.argv);
if (!args.character) fail("--character is required, e.g. --character \"Mia Lin\"");

const cfg = loadConfig();
ensureDirs(cfg);
const mode = args.mode || cfg.mode || "std";
const count = Math.min(Math.max(args.count, 1), cfg.max_videos_per_request || 10);

const creditsStart = await getCredits();
if (creditsStart === null) fail("Not logged in to Higgsfield. The USER must connect the account (see SKILL.md auth section).");
if (creditsStart < (cfg.credit_floor || 0)) {
  fail(`Credit balance ${creditsStart} is below the safety floor of ${cfg.credit_floor}.`);
}
console.log(`Credits: ${creditsStart}`);

const { chosen, all } = await resolveCharacter(args.character);
if (!chosen) {
  fail(`No trained character matches "${args.character}". Available: ${all.map((c) => c.name).join(", ") || "(none)"}`);
}
console.log(`Character: ${chosen.name} (${chosen.id})  |  mode: ${mode}  |  direct method`);

if (args.clip && !existsSync(args.clip)) fail(`Clip not found: ${args.clip}`);
if (!args.clip && listClips(cfg, chosen.name).length === 0) {
  fail(`No motion clips found. Add .mp4/.mov/.webm files to: ${cfg.motion_dir}`);
}

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
if (extra) prompts = prompts.map((p) => `${p}\n\n${extra}`);

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");
const uploadCache = new Map();
const results = [];
const failures = [];
let failed = 0;

for (let i = 0; i < count; i++) {
  const label = `${slug(chosen.name)}_${stamp}_${i + 1}`;
  const tag = `[${i + 1}/${count}]`;
  let stage = "image";
  let soul = null;
  let kling = null;
  let imageFile = null;
  let clipPath = null;
  let clipRef = null;
  try {
    // 1) Soul 2.0 image, blocking until rendered
    console.log(`${tag} generating Soul 2.0 image of ${chosen.name}...`);
    soul = parseJob(await hf([
      "generate", "create", "text2image_soul_v2",
      "--prompt", prompts[i],
      "--soul-id", chosen.id,
      "--aspect_ratio", cfg.aspect_ratio || "9:16",
      "--quality", cfg.quality || "2k",
      "--wait", "--json",
    ], { timeoutMs: 15 * 60 * 1000 }));
    if (soul.status !== "completed") throw new Error(`image job ${soul.id} ended: ${soul.status}`);
    if (soul.result_url) {
      imageFile = join(cfg.output_dir, `${label}_image.png`);
      try { await download(soul.result_url, imageFile); } catch { imageFile = null; }
    }

    // 2) upload the motion clip once per file
    stage = "upload";
    clipPath = args.clip || pickClip(cfg, chosen.name);
    clipRef = uploadCache.get(clipPath);
    if (!clipRef) {
      console.log(`${tag} uploading motion clip ${basename(clipPath)}...`);
      const up = JSON.parse(await hf(["upload", "create", clipPath, "--json"], { timeoutMs: 10 * 60 * 1000 }));
      const upObj = Array.isArray(up) ? up[0] : up;
      if (!upObj?.id) throw new Error("clip upload returned no id");
      clipRef = upObj.id;
      uploadCache.set(clipPath, clipRef);
    }

    // mirror into the queue BEFORE the long video step so a killed run is
    // recoverable by check.mjs (its adopt-scan finds the job if it registered)
    const item = {
      id: label,
      character: chosen.name,
      stage: "ready",
      soul_job: soul.id,
      kling_job: null,
      clip: clipPath,
      clip_upload_id: clipRef,
      mode,
      prompt: prompts[i].slice(0, 300),
      prompt_source: promptSource,
      image_file: imageFile,
      created: new Date().toISOString(),
      submit_started: new Date().toISOString(),
    };
    queueUpsert(cfg, item);

    // 3) Kling 3.0 Motion Control, blocking until rendered
    //    (--wait is REQUIRED: without it the CLI hangs and no job is created)
    stage = "video";
    console.log(`${tag} animating with motion from ${basename(clipPath)} (${mode}) — this takes several minutes...`);
    kling = parseCreate(await hf([
      "generate", "create", "kling3_0_motion_control",
      "--image", soul.id,
      "--video", clipRef,
      "--mode", mode,
      "--background_source", cfg.background_source || "input_image",
      "--wait", "--wait-timeout", "30m", "--json",
    ], { timeoutMs: 35 * 60 * 1000 }));
    if (kling.status !== "completed") throw new Error(`video job ${kling.id} ended: ${kling.status}`);
    item.kling_job = kling.id;
    item.stage = "video";
    queueUpsert(cfg, item);

    const url = kling.result_url || kling.min_result_url;
    if (!url) throw new Error(`video job ${kling.id} finished but returned no result URL`);

    // 4) download + record, then clear from the queue
    console.log(`${tag} downloading...`);
    const videoFile = join(cfg.output_dir, `${label}.mp4`);
    await download(url, videoFile);
    appendManifest(cfg, {
      time: new Date().toISOString(),
      character: chosen.name,
      video: `${label}.mp4`,
      image: imageFile ? basename(imageFile) : null,
      clip: basename(clipPath),
      prompt_source: promptSource,
      prompt: prompts[i].slice(0, 300),
      soul_job: soul.id,
      kling_job: kling.id,
      result_url: url,
    });
    queueRemove(cfg, label);
    results.push({ video: videoFile, image: imageFile });
    console.log(`${tag} DONE -> ${videoFile}`);
  } catch (e) {
    failed++;
    const message = String(e?.message || e);
    const job = kling || soul || null;
    const errorType = classifyFailure(message, job);
    const failure = {
      time: new Date().toISOString(),
      character: chosen.name,
      label,
      stage,
      error_type: errorType,
      status: job?.status || null,
      message,
      soul_job: soul?.id || null,
      kling_job: kling?.id || null,
      job_type: job?.job_type || null,
      result_url: job?.result_url || null,
      image: imageFile ? basename(imageFile) : null,
      clip: clipPath ? basename(clipPath) : null,
      retryable: !["content_blocked", "auth", "credits"].includes(errorType),
    };
    failures.push(failure);
    appendFailure(cfg, failure);
    queueRemove(cfg, label);
    console.error(`${tag} FAILED: ${message}`);
  }
}

const creditsEnd = await getCredits();
const spent = creditsStart !== null && creditsEnd !== null
  ? Math.round((creditsStart - creditsEnd) * 100) / 100 : null;

console.log(`Finished: ${results.length} ok, ${failed} failed.` + (spent !== null ? ` Credits spent: ${spent} (left: ${creditsEnd})` : ""));
console.log("RESULT:" + JSON.stringify({
  ok: failed === 0,
  method: "direct",
  character: chosen.name,
  made: results,
  failed,
  failures,
  credits_spent: spent,
  credits_left: creditsEnd,
  next: failed > 0
    ? "Report the failures. Retryable ones can be re-run with the same command."
    : "All done. Deliver the files in made[].",
}));
process.exit(failed > 0 && results.length === 0 ? 1 : 0);
