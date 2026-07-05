// Make character videos: outfit prompt -> Soul 2.0 image -> Kling 3.0 Motion Control -> MP4.
//
//   node scripts/make-videos.mjs --character "Mia Lin" --count 1
//   node scripts/make-videos.mjs --character mia --count 5 --mode pro
//   node scripts/make-videos.mjs --character mia --dry-run          (plan + cost, spends nothing)
//
// Flags:
//   --character <name>   required; fuzzy-matched against trained Soul characters
//   --count <n>          default 1, capped by config.max_videos_per_request
//   --clip <path>        use this motion clip for every video (default: random per video)
//   --prompt <text>      use this prompt for every video (default: random outfit prompt)
//   --extra-prompt <t>   appended to every prompt (steer scene/lighting/vibe on top of the random outfit)
//   --mode std|pro       Kling quality mode (default from config)
//   --dry-run            show the plan without spending credits
//
// Prints human-readable progress; the last line is machine-readable JSON (RESULT:{...}).

import {
  loadConfig, ensureDirs, hf, parseJob, getCredits, resolveCharacter,
  fetchOutfitPrompts, pickClip, listClips, slug, appendManifest, appendFailure,
  download, ROOT,
} from "./lib.mjs";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const args = { count: 1, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--character") args.character = argv[++i];
    else if (a === "--count") args.count = parseInt(argv[++i], 10) || 1;
    else if (a === "--clip") args.clip = argv[++i];
    else if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--extra-prompt") args.extraPrompt = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

const JOB_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function classifyFailure(message, job) {
  const status = job?.status || "";
  if (status === "nsfw" || /nsfw|content filter|moderation/i.test(message)) return "content_blocked";
  if (status === "failed" || /status "failed"|status failed|generation failed/i.test(message)) return "generation_failed";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/not authenticated|session expired|login/i.test(message)) return "auth";
  if (/credits|balance|floor/i.test(message)) return "credits";
  return "unknown";
}

async function jobFromError(error) {
  const message = String(error?.message || error || "");
  const id = message.match(JOB_ID_RE)?.[0] || null;
  if (!id) return { id: null, job: null };
  try {
    return { id, job: parseJob(await hf(["generate", "get", id, "--json"], { timeoutMs: 60_000 })) };
  } catch {
    return { id, job: null };
  }
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
  fail("Not logged in to Higgsfield. Run: higgsfield auth login");
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
  console.log("RESULT:" + JSON.stringify({ ok: true, dry_run: true, character: chosen.name, videos_planned: count, prompt_source: promptSource }));
  process.exit(0);
}

// --- generate ---
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1_$2");
const uploadCache = new Map(); // clip path -> higgsfield upload id (avoid re-uploading)
const results = [];
const failures = [];
let failed = 0;

for (let i = 0; i < count; i++) {
  const label = `${slug(chosen.name)}_${stamp}_${i + 1}`;
  const tag = `[${i + 1}/${count}]`;
  let stage = "starting";
  let soul = null;
  let kling = null;
  let imageFile = null;
  let clipPath = null;
  let clipRef = null;
  try {
    // 1) Soul 2.0 image with the character identity
    stage = "image";
    console.log(`${tag} generating Soul 2.0 image of ${chosen.name}...`);
    soul = parseJob(await hf([
      "generate", "create", "text2image_soul_v2",
      "--prompt", prompts[i],
      "--soul-id", chosen.id,
      "--aspect_ratio", cfg.aspect_ratio || "9:16",
      "--quality", cfg.quality || "2k",
      "--wait", "--json",
    ]));
    if (soul.status !== "completed") throw new Error(`image job ${soul.id} ended: ${soul.status}`);
    if (soul.result_url) {
      imageFile = join(cfg.output_dir, `${label}_image.png`);
      try { await download(soul.result_url, imageFile); } catch { imageFile = null; }
    }

    // 2) pick motion clip and upload it explicitly (the CLI hangs if generate
    //    create has to auto-upload a local video for this job type); cache the
    //    upload id so the same file only uploads once per run
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

    // 3) Kling 3.0 Motion Control — Soul job id feeds in directly
    stage = "video";
    console.log(`${tag} animating with motion from ${basename(clipPath)} (${mode})...`);
    kling = parseJob(await hf([
      "generate", "create", "kling3_0_motion_control",
      "--image", soul.id,
      "--video", clipRef,
      "--mode", mode,
      "--background_source", cfg.background_source || "input_image",
      "--wait", "--wait-timeout", "30m", "--json",
    ]));
    if (kling.status !== "completed") throw new Error(`video job ${kling.id} ended: ${kling.status}`);

    const url = kling.result_url || kling.min_result_url;
    if (!url) throw new Error(`video job ${kling.id} finished but returned no result URL`);

    // 4) download
    console.log(`${tag} downloading...`);
    const videoFile = join(cfg.output_dir, `${label}.mp4`);
    await download(url, videoFile);

    const entry = {
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
    };
    appendManifest(cfg, entry);
    results.push(entry);
    console.log(`${tag} DONE -> ${videoFile}`);
  } catch (e) {
    failed++;
    const message = String(e?.message || e);
    const failedJob = await jobFromError(e);
    if (!kling && failedJob.job?.job_type?.includes("motion_control")) kling = failedJob.job;
    if (!soul && failedJob.job?.job_type?.includes("soul")) soul = failedJob.job;

    const job = failedJob.job || kling || soul || null;
    const errorType = classifyFailure(message, job);
    const failure = {
      time: new Date().toISOString(),
      character: chosen.name,
      index: i + 1,
      stage,
      error_type: errorType,
      status: job?.status || null,
      message,
      soul_job: soul?.id || null,
      kling_job: kling?.id || failedJob.id,
      job_type: job?.job_type || null,
      result_url: job?.result_url || null,
      image: imageFile ? basename(imageFile) : null,
      clip: clipPath ? basename(clipPath) : null,
      retryable: !["content_blocked", "auth", "credits"].includes(errorType),
    };
    failures.push(failure);
    appendFailure(cfg, failure);
    console.error(`${tag} FAILED: ${message}`);
    console.error(`${tag} FAILURE_JSON:${JSON.stringify(failure)}`);
  }
}

const creditsEnd = await getCredits();
const spent = creditsStart !== null && creditsEnd !== null
  ? Math.round((creditsStart - creditsEnd) * 100) / 100 : null;

console.log(`Finished: ${results.length} ok, ${failed} failed.` + (spent !== null ? ` Credits spent: ${spent} (left: ${creditsEnd})` : ""));
console.log("RESULT:" + JSON.stringify({
  ok: failed === 0,
  character: chosen.name,
  made: results.map((r) => ({ video: join(cfg.output_dir, r.video), image: r.image ? join(cfg.output_dir, r.image) : null })),
  failed,
  failures,
  credits_spent: spent,
  credits_left: creditsEnd,
}));
process.exit(failed > 0 && results.length === 0 ? 1 : 0);
