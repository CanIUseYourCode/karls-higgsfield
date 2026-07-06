// Detached worker: submits ONE Kling 3.0 Motion Control job for a queue item.
// The Kling create endpoint can block for many minutes before returning the
// job id, so check.mjs spawns this script detached (fire-and-forget) and
// collects the result from a sidecar file on a later run.
//
//   node scripts/submit-video.mjs <queue-item-id>
//
// Writes output/.submit-<queue-item-id>.json:
//   { ok: true,  kling_job: "<id>", finished_at: iso }
//   { ok: false, error: "<message>", finished_at: iso }
//
// Never touches queue.json (check.mjs owns it).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, hf, parseCreate, readQueue } from "./lib.mjs";

const itemId = process.argv[2];
const cfg = loadConfig();

function sidecarPath(id) {
  return join(cfg.output_dir, `.submit-${id}.json`);
}

function finish(result) {
  writeFileSync(sidecarPath(itemId), JSON.stringify({ ...result, finished_at: new Date().toISOString() }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (!itemId) {
  console.error("usage: node scripts/submit-video.mjs <queue-item-id>");
  process.exit(1);
}

const item = readQueue(cfg).find((q) => q.id === itemId);
if (!item) finish({ ok: false, error: `queue item ${itemId} not found` });
if (item.kling_job) finish({ ok: true, kling_job: item.kling_job });

try {
  // IMPORTANT: --wait is required. Without it the CLI's create call for
  // motion control hangs indefinitely and the job is never registered;
  // with it the job appears server-side within seconds (measured live).
  // Blocking through the render is fine — this worker is detached, and
  // check.mjs adopts the job id from `generate list` long before we return.
  const kling = parseCreate(await hf([
    "generate", "create", "kling3_0_motion_control",
    "--image", item.soul_job,
    "--video", item.clip_upload_id,
    "--mode", item.mode,
    "--background_source", cfg.background_source || "input_image",
    "--wait", "--wait-timeout", "30m",
    "--json",
  ], { timeoutMs: 35 * 60 * 1000 }));
  if (!kling?.id) finish({ ok: false, error: "video submit returned no job id" });
  finish({ ok: true, kling_job: kling.id });
} catch (e) {
  finish({ ok: false, error: String(e?.message || e) });
}
