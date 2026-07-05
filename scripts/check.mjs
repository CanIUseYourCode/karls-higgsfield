// Advance pending video jobs and collect finished MP4s. The other half of
// make-videos.mjs (which only SUBMITS). Free, idempotent, never blocks:
// every run finishes in seconds.
//
//   node scripts/check.mjs
//
// Run it every ~2 minutes until RESULT.all_done is true. The last line is
// RESULT:{...} JSON — RESULT.next always says the exact next command to run.
//
// What one run does, per queued item:
//   stage "image":  Soul image done?  -> download image, stage "ready"
//   stage "ready":  video slot free?  -> submit Kling 3.0 job, stage "video"
//   stage "video":  video done?       -> download MP4, add to manifest, remove
//   any failure                       -> record in output/failures.json, remove

import {
  loadConfig, ensureDirs, hf, parseJob, getCredits, classifyFailure,
  readQueue, writeQueue, appendManifest, appendFailure, download,
} from "./lib.mjs";
import { join, basename } from "node:path";

const DONE_STATUSES = ["completed", "failed", "nsfw", "canceled", "cancelled"];
const MAKE_CMD = 'node scripts/make-videos.mjs --character "<name>" --count <N>';
const CHECK_CMD = "node scripts/check.mjs";

const cfg = loadConfig();
ensureDirs(cfg);
const queue = readQueue(cfg);

if (queue.length === 0) {
  console.log("Queue is empty — nothing is rendering.");
  console.log("RESULT:" + JSON.stringify({
    ok: true, pending: 0, stages: { image: 0, ready: 0, video: 0 },
    finished_now: [], failed_now: [], all_done: true,
    next: `Nothing pending. To make videos: ${MAKE_CMD}`,
  }));
  process.exit(0);
}

async function getJob(id) {
  return parseJob(await hf(["generate", "get", id, "--json"], { timeoutMs: 60_000 }));
}

const finishedNow = [];
const failedNow = [];
const keep = [];
const maxActive = cfg.max_active_videos || 2;
let activeVideos = queue.filter((q) => q.stage === "video").length;
let authError = null;

function recordFailure(item, job, message) {
  const errorType = classifyFailure(message, job);
  const failure = {
    time: new Date().toISOString(),
    character: item.character,
    label: item.id,
    stage: item.stage,
    error_type: errorType,
    status: job?.status || null,
    message,
    soul_job: item.soul_job || null,
    kling_job: item.kling_job || null,
    job_type: job?.job_type || null,
    result_url: job?.result_url || null,
    image: item.image_file ? basename(item.image_file) : null,
    clip: item.clip ? basename(item.clip) : null,
    retryable: !["content_blocked", "auth", "credits"].includes(errorType),
  };
  appendFailure(cfg, failure);
  failedNow.push(failure);
  console.error(`[${item.id}] FAILED (${item.stage}): ${message}`);
}

async function submitVideo(item) {
  console.log(`[${item.id}] image ready — submitting Kling 3.0 video (${item.mode})...`);
  const kling = parseJob(await hf([
    "generate", "create", "kling3_0_motion_control",
    "--image", item.soul_job,
    "--video", item.clip_upload_id,
    "--mode", item.mode,
    "--background_source", cfg.background_source || "input_image",
    "--json",
  ], { timeoutMs: 3 * 60 * 1000 }));
  if (!kling?.id) throw new Error("video submit returned no job id");
  item.kling_job = kling.id;
  item.stage = "video";
  activeVideos++;
}

for (let idx = 0; idx < queue.length; idx++) {
  const item = queue[idx];
  try {
    if (item.stage === "image") {
      const job = await getJob(item.soul_job);
      if (job.status === "completed") {
        if (job.result_url) {
          const imageFile = join(cfg.output_dir, `${item.id}_image.png`);
          try { await download(job.result_url, imageFile); item.image_file = imageFile; } catch { /* image is a nice-to-have */ }
        }
        item.stage = "ready";
      } else if (DONE_STATUSES.includes(job.status)) {
        recordFailure(item, job, `image job ${item.soul_job} ended: ${job.status}`);
        continue; // drop from queue
      } else {
        console.log(`[${item.id}] image still rendering (${job.status})`);
      }
    }

    if (item.stage === "ready") {
      if (activeVideos < maxActive) {
        await submitVideo(item);
      } else {
        console.log(`[${item.id}] image ready — waiting for a video slot (${activeVideos}/${maxActive} busy)`);
      }
    } else if (item.stage === "video" && item.kling_job) {
      const job = await getJob(item.kling_job);
      if (job.status === "completed") {
        const url = job.result_url || job.min_result_url;
        if (!url) throw new Error(`video job ${item.kling_job} finished but returned no result URL`);
        console.log(`[${item.id}] video done — downloading...`);
        const videoFile = join(cfg.output_dir, `${item.id}.mp4`);
        await download(url, videoFile);
        appendManifest(cfg, {
          time: new Date().toISOString(),
          character: item.character,
          video: `${item.id}.mp4`,
          image: item.image_file ? basename(item.image_file) : null,
          clip: basename(item.clip),
          prompt_source: item.prompt_source,
          prompt: (item.prompt || "").slice(0, 300),
          soul_job: item.soul_job,
          kling_job: item.kling_job,
          result_url: url,
        });
        finishedNow.push({ video: videoFile, image: item.image_file || null, character: item.character });
        activeVideos--;
        console.log(`[${item.id}] DONE -> ${videoFile}`);
        continue; // drop from queue
      } else if (DONE_STATUSES.includes(job.status)) {
        activeVideos--;
        recordFailure(item, job, `video job ${item.kling_job} ended: ${job.status}`);
        continue; // drop from queue
      } else {
        console.log(`[${item.id}] video still rendering (${job.status})`);
      }
    }

    keep.push(item);
  } catch (e) {
    const message = String(e?.message || e);
    keep.push(item); // never lose an item over a transient error
    if (/not authenticated|session expired|login/i.test(message)) {
      authError = message;
      keep.push(...queue.slice(idx + 1)); // auth is global — stop checking
      break;
    }
    console.error(`[${item.id}] check error (will retry next run): ${message}`);
  }
}

writeQueue(cfg, keep);

const stages = { image: 0, ready: 0, video: 0 };
for (const q of keep) stages[q.stage] = (stages[q.stage] || 0) + 1;
const pending = keep.length;
const credits = await getCredits();

let next;
if (authError) {
  next = `Not logged in. The USER must run: higgsfield auth login — then run: ${CHECK_CMD}`;
} else if (pending === 0) {
  next = "All done. Deliver the videos in finished_now (full history: output/manifest.json).";
} else {
  next = `Wait about 2 minutes, then run again: ${CHECK_CMD}`;
}

console.log(
  `Pending: ${pending} (${stages.image} image, ${stages.ready} awaiting slot, ${stages.video} video)` +
  ` | finished now: ${finishedNow.length}, failed now: ${failedNow.length}` +
  (credits !== null ? ` | credits left: ${credits}` : "")
);
console.log("RESULT:" + JSON.stringify({
  ok: !authError,
  pending,
  stages,
  finished_now: finishedNow,
  failed_now: failedNow,
  all_done: pending === 0,
  credits_left: credits,
  next,
  ...(authError ? { error: authError } : {}),
}));
