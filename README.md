# Higgsfield Factory

A reusable **MaxAgents / OpenClaw** skill that turns a Higgsfield subscription
into an automated character-video factory. You talk to your agent in plain
language:

> **"Make 3 videos of Mia Lin"**

…and for each video the agent:

1. Fetches a random outfit prompt (from your [outfit-extractor](https://outfit-extractor.vercel.app) API, with automatic Firestore fallback)
2. Submits a **Soul 2.0** image of that character wearing it (9:16, your realism defaults)
3. Picks a random motion clip from your pool and queues **Kling 3.0 Motion Control**
4. Collects the finished MP4 and hands it back — and lists it on a local dashboard

Generation is **fully non-blocking**: `make-videos.mjs` submits jobs and exits
in seconds; `check.mjs` (run every couple of minutes) advances the pipeline and
downloads whatever finished. No script ever sits waiting on a render, so agent
shell timeouts can't break a batch — state lives in `output/queue.json`.

It also trains new Soul characters from a folder of photos, and ships a web
dashboard to browse everything generated.

Runs entirely on the official [Higgsfield CLI](https://higgsfield.ai/cli) — your
normal account login and plan credits. No developer API key, no scraping, no
passwords through the agent.

---

## Requirements

- **Node.js 18+** and npm on the machine where the agent runs
- A **Higgsfield account** with credits (any plan)
- The **Higgsfield CLI** (`@higgsfield/cli`) — the skill installs it during onboarding

---

## Install into your agent

Clone into your agent's skills directory (typically `~/.openclaw/skills/` or your
MaxAgents workspace `skills/` folder — wherever skills are discovered):

```bash
git clone https://github.com/<you>/higgsfield-factory <skills-dir>/higgsfield-factory
```

Then just talk to your agent — say **"set up Higgsfield"** and it runs onboarding.

---

## Onboarding (what the agent walks you through)

The agent runs `node scripts/onboard.mjs --json` and guides you through whatever
is missing, in order:

1. **Install the CLI** — the agent runs `npm install -g @higgsfield/cli` for you.
2. **Connect your account** — YOU run this once in a terminal:
   ```bash
   higgsfield auth login
   ```
   A browser opens for a ~5-second sign-in. No API key, and the agent never sees
   your password.
   - **Headless server / cloud agent (MaxAgents etc.)?** `auth login` cannot
     work there — the URL it prints redirects to `localhost` on the server, so
     clicking it from your own browser never completes. Instead:
     1. On your own computer: `npm install -g @higgsfield/cli`, then
        `higgsfield auth login` (normal browser sign-in).
     2. Open `~/.higgsfield/credentials.json`
        (Windows: `C:\Users\<you>\.higgsfield\credentials.json`) and paste its
        contents to the agent.
     3. The agent runs `node scripts/import-auth.mjs '<pasted JSON>'` on the
        server and verifies the connection.
     The file is a revocable login token (not your password); `higgsfield auth
     logout` invalidates it. Logins use refresh tokens, so the server stays
     connected afterward. (SSH users can alternatively tunnel the callback
     port: `ssh -L 8765:localhost:8765 user@server` and log in through that.)
3. **Add motion clips** — send the agent (or drop into `motion_videos/`) the
   video clips whose MOVEMENT you want characters to copy (a dance, a walk, a
   pose). A subfolder named after a character (e.g. `motion_videos/Mia Lin/`)
   makes those clips exclusive to that character; loose clips are shared.
4. **Have a character** — either use one you've already trained, or ask the agent
   to create one from photos (see below).

Re-running onboarding any time re-checks everything; it's safe and free.

---

## What you can say

| You say | The agent runs |
|---|---|
| "set up Higgsfield" / "am I ready?" | `node scripts/onboard.mjs --json` |
| "how many credits / what characters do I have?" | `node scripts/status.mjs --json` |
| "make 1 video of Mia" | `make-videos.mjs --character "Mia" --count 1`, then `check.mjs` every ~2 min |
| "make 5 pro videos of yumi at golden hour" | `make-videos.mjs --character yumi --count 5 --mode pro --extra-prompt "golden hour"` |
| "are my videos done?" | `check.mjs` (free — downloads whatever finished) |
| "how much would 10 videos cost?" | `make-videos.mjs ... --dry-run` (spends nothing) |
| "did this Higgs job fail?" | `job-status.mjs --job <job_id>` |
| "create a character called Ana from these photos" | `create-character.mjs --name "Ana" --images <folder>` |
| "show me my videos" | `serve-ui.mjs` → http://localhost:7788 |

Results land in `output/`: the MP4, the Soul reference image, and `manifest.json`
(the dashboard's index).

Failures land in `output/failures.json`. Agent runtimes should parse the final
`RESULT:{...}` line from every script, not the human progress text.

---

## Agent runtime contract

This repo is designed to be reusable from OpenClaw, Hermes, MaxAgents, or an EC2
agent runner.

Required behavior:

1. Run `node scripts/onboard.mjs --json` before spending credits.
2. Parse only the last `RESULT:{...}` line from each script, and follow
   `RESULT.next` — it always contains the literal next command.
3. Submit with `make-videos.mjs`, then run `check.mjs` every ~2 minutes until
   `RESULT.all_done` is true. Both exit fast; neither waits on renders.
4. Never re-run `make-videos.mjs` while videos are pending (it refuses without
   `--force`) — "not done yet" means run `check.mjs` again, nothing else.
5. Job tracking is automatic via `output/queue.json`; if the agent is
   interrupted at any point, running `check.mjs` recovers everything.
6. Use `RESULT.failed_now[]` / `output/failures.json` to decide retry behavior.
   `job-status.mjs --job <id>` exists for forensic checks on a single job.

Failure fields include:

| field | meaning |
|---|---|
| `stage` | `image`, `upload`, or `video` |
| `error_type` | `generation_failed`, `content_blocked`, `timeout`, `auth`, `credits`, or `unknown` |
| `status` | Higgsfield job status when known |
| `soul_job` / `kling_job` | Higgsfield ids to inspect or retry |
| `retryable` | false for moderation/auth/credit failures |

Parallel video jobs are supported by Higgsfield (a live test accepted two
Kling 3.0 Motion Control jobs at the same timestamp). `check.mjs` enforces the
concurrency cap itself via `max_active_videos` in config (default 5) — images
that finish while all video slots are busy wait in the queue as `ready` and are
promoted automatically on a later `check.mjs` run. If Higgsfield ever rejects
a submit (e.g. a plan-level concurrency limit), the item simply stays `ready`
and is retried on the next run — nothing is lost, so the cap is a throttle,
not a correctness requirement. Each queue item carries its OWN Soul image job
id and clip; the video step is always submitted with that item's image, so
image↔video pairing is 1:1 by construction (auditable per row in
`output/manifest.json`).

---

## How control works

| Dial | Set by |
|---|---|
| **Who** (identity/face) | the character name → its trained Soul ID |
| **What they wear** | random outfit from your database (or `--prompt` to fully override) |
| **Where / lighting / vibe** | `--extra-prompt` (+ the realism default in config) |
| **How they move** | the motion clip |
| **Quality** | `pro` 1080p (default) or `--mode std` 720p to save credits |

> **Note on video prompts:** Kling 3.0 Motion Control does not accept a text
> prompt on the CLI/API surface — the web UI's prompt box uses a separate,
> unsupported endpoint. All look/scene direction is applied on the **image**
> step (`--prompt` / `--extra-prompt`), which is where it actually matters; the
> motion (matching camera + character movement) is what Motion Control does by
> default. This keeps the skill on Higgsfield's supported, stable API.

---

## Dashboard

```bash
node scripts/serve-ui.mjs        # http://localhost:7788
```

Dark-mode gallery of every generated video: play inline, filter by character,
download, live credit balance. Read-only — never spends credits. The agent keeps
it running in the background when you ask to see your videos.

---

## Configuration (`config.json`)

Created from `config.default.json` on first onboarding. Notable keys:

| key | default | meaning |
|---|---|---|
| `aspect_ratio` | `9:16` | Soul image ratio |
| `quality` | `2k` | Soul image quality |
| `mode` | `pro` | Kling quality: `pro` = 1080p (~38 cr/video), `std` = 720p (~23 cr) |
| `background_source` | `input_image` | keep the image's background, or `input_video` |
| `max_active_videos` | `5` | Kling jobs rendering at once; extra images wait as `ready` (a rejected submit just retries next check) |
| `max_videos_per_request` | `10` | hard cap per request |
| `credit_floor` | `25` | refuse to start below this balance |
| `extra_prompt` | realism string | appended to every image prompt |
| `prompt_api` | outfit-extractor URL | primary prompt source (text/plain) |
| `prompt_preset` | `""` | prepended to Firestore-fallback prompts |
| `firestore_fallback` | (Firestore query) | used automatically if `prompt_api` is down |
| `ui_port` | `7788` | dashboard port |

---

## Safety rails (built in)

- Batch size hard-capped per request; the agent confirms anything over 5.
- `credit_floor` stops runs before your account is drained.
- Training a character always requires explicit confirmation (it costs credits).
- Account login is always done by you in a browser — the agent never touches
  passwords.
- Content blocked by Higgsfield's filter surfaces as a clean `nsfw` job status,
  not a crash.

---

## Costs (measured)

- Soul 2.0 image: **~0.12 credits**
- Kling 3.0 Motion Control (13s clip, `std`): **~23 credits** per video
  (`pro` and longer clips cost more)

Run one video and check `node scripts/status.mjs` to calibrate for your plan and
clip lengths.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Not authenticated" / no credits shown | `higgsfield auth login` |
| `higgsfield` not found | `npm install -g @higgsfield/cli`. On Windows, if npm's postinstall fails with a tar error, download `hf.exe` from the [CLI releases](https://github.com/higgsfield-ai/cli/releases) and set `HIGGSFIELD_BIN` to its full path. |
| Video generation seems stuck | Nothing blocks anymore — renders happen server-side. Run `node scripts/check.mjs`; it reports per-item progress and downloads whatever finished. |
| Job comes back `nsfw` | Higgsfield's content filter blocked it. Not a bug — soften the outfit/scene wording. |
| Outfit prompts fail | The skill auto-falls back to the Firestore database; only an issue if both are down. |
| Dashboard shows no data | The dashboard needs its server running (`serve-ui.mjs`); opening the HTML file directly won't work. |

---

## Repo layout

```
higgsfield-factory/
  SKILL.md              agent playbook (how the agent uses this)
  README.md             this file
  config.default.json   defaults (copied to config.json on setup)
  scripts/
    lib.mjs             shared helpers (CLI wrapper, prompts, clips, downloads)
    onboard.mjs         setup state machine (--json for agents)
    status.mjs          credits + inventory (--json)
    make-videos.mjs     submit jobs (fast, non-blocking)
    check.mjs           advance queue + download finished MP4s (free, run repeatedly)
    job-status.mjs      inspect a single Higgsfield job (debugging)
    import-auth.mjs     connect a headless machine using credentials.json from a browser machine
    create-character.mjs Soul training from photos
    serve-ui.mjs        dashboard server
  ui/index.html         dashboard page
```

## License

MIT — see [LICENSE](LICENSE).
