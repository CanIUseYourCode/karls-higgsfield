// Read one Higgsfield generation job or recent video jobs.
//
//   node scripts/job-status.mjs --job <job_id>
//   node scripts/job-status.mjs --recent 10
//
// Read-only. Last line is RESULT:{...} for agents.

import { hf, parseJob } from "./lib.mjs";

function parseArgs(argv) {
  const args = { recent: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--job") args.job = argv[++i];
    else if (a === "--recent") args.recent = parseInt(argv[++i], 10) || 10;
  }
  return args;
}

function summarize(job) {
  return {
    id: job.id,
    job_type: job.job_type,
    display_name: job.display_name,
    status: job.status,
    created_at: job.created_at,
    result_url: job.result_url || job.min_result_url || null,
    failed: ["failed", "nsfw", "canceled", "cancelled"].includes(job.status),
    done: ["completed", "failed", "nsfw", "canceled", "cancelled"].includes(job.status),
  };
}

const args = parseArgs(process.argv);

try {
  let result;
  if (args.job) {
    const job = parseJob(await hf(["generate", "get", args.job, "--json"], { timeoutMs: 60_000 }));
    result = { ok: true, job: summarize(job), raw: job };
  } else {
    const size = String(Math.min(Math.max(args.recent || 10, 1), 50));
    const jobs = JSON.parse(await hf(["generate", "list", "--video", "--size", size, "--json"], { timeoutMs: 60_000 }));
    result = { ok: true, jobs: jobs.map(summarize) };
  }
  console.log("RESULT:" + JSON.stringify(result));
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
}
