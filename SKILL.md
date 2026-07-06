---
name: higgsfield-factory
description: >
  Make AI character videos on Higgsfield: random outfit prompt -> Soul 2.0
  character image -> Kling 3.0 Motion Control with a motion clip -> MP4.
  Trigger when the user asks to make/generate video(s) of a named character,
  create/train a character from photos, connect a Higgsfield account, add
  motion clips, check credits/characters, or open the video dashboard.
---

# Higgsfield Factory — agent playbook

You (the agent) drive a local pipeline via small Node scripts.

Three facts about every script — rely on them:

1. **No script ever waits for a render.** Every command exits in seconds to
   ~2 minutes. If you think a command is "generating a video", you are wrong —
   renders happen on Higgsfield's servers while no script is running.
2. The LAST output line is machine-readable `RESULT:{...}` JSON. Parse that
   line only; never scrape the prose above it.
3. `RESULT.next` is the literal next command to run (or thing to do).
   **When unsure, do exactly what `next` says.**

Run all commands from THIS skill's folder. Node 18+ required.
Scripts that spend credits: `make-videos.mjs`, `create-character.mjs`.
Everything else is free. The user's Higgsfield password is NEVER handled by
you; connecting the account is always the user running `higgsfield auth login`
themselves — you cannot run it for them.

## Golden rule: check readiness first

Before the first video of a session, or whenever anything fails with a
setup/auth error, run:

```bash
node scripts/onboard.mjs --json
```

If `RESULT.ready` is true, proceed. If false, walk the user through
`next_steps` IN ORDER (`who: "user"` steps are theirs; relay the `action`
plainly and wait). Do not generate until `ready` is true.

- `install_cli` → offer to run `npm install -g @higgsfield/cli` (you may).
- `auth_login` → TWO CASES, pick one:
  - **This machine can open a browser** (you are running on the user's own
    computer): tell the user to run `higgsfield auth login` in a terminal.
    A browser opens, they sign in, done.
  - **This machine is headless/cloud** (typical agent runtime — MaxAgents,
    a server, a container): **DO NOT run `higgsfield auth login` here, and
    NEVER send the user the long OAuth URL it prints.** That URL redirects to
    `localhost` on THIS machine — clicking it from the user's browser can
    never complete. There is no device-code login in the CLI. Instead say,
    word for word: *"On your own computer: 1) install the CLI with
    `npm install -g @higgsfield/cli`  2) run `higgsfield auth login` and sign
    in  3) open the file `~/.higgsfield/credentials.json` (on Windows:
    `C:\Users\<you>\.higgsfield\credentials.json`) and paste its contents
    here."* Then run `node scripts/import-auth.mjs '<pasted JSON>'` and re-run
    onboarding. The paste is a revocable login token, not a password.
- `add_motion_clips` → ask for clip(s) whose MOVEMENT the character should
  copy; save them into `motion_videos/` (or a character-named subfolder).
- `create_character` → see "Create a character" below.

## Make videos — the only flow

Two commands, in a loop. That's the whole system:

```bash
# 1) SUBMIT — spends credits, exits in ~1 minute
node scripts/make-videos.mjs --character "<name>" --count <N>

# 2) COLLECT — free, exits in seconds; run every ~2 minutes
node scripts/check.mjs
```

`make-videos.mjs` uploads the motion clip, submits the image jobs, saves the
work list to `output/queue.json`, and exits. `check.mjs` does everything else:
when an image is ready it starts the video submit in a DETACHED background
worker (Higgsfield's video-create call can block 10-20+ minutes before
returning a job id — the worker absorbs that, not you), and when a video is
ready it downloads the MP4. `check.mjs` itself always exits in seconds;
output like "video submit still in progress" is normal, keep checking.
Repeat `check.mjs` (wait ~2 minutes between runs) until `RESULT.all_done` is
true, then deliver the files from `finished_now` (full history:
`output/manifest.json`).

Parallelism is handled entirely inside `check.mjs` (config
`max_active_videos`). You never manage parallel jobs, pick image references,
or match images to videos — every queued item is hard-wired to its own image
job and clip. Just run the two commands above.

### HARD RULES — these prevent wasted credits

1. **"Not done yet" is not an error.** While videos render, the ONLY correct
   command is `node scripts/check.mjs`. It is free, idempotent, and safe to
   run any number of times.
2. **NEVER re-run `make-videos.mjs` because videos aren't done** — that
   submits NEW paid jobs. It refuses to double-submit for a character that
   already has pending videos unless you pass `--force`; treat that refusal
   as "run check.mjs", not as an error to work around.
3. **NEVER call the `higgsfield` CLI directly** for image/video generation.
   Only these scripts. (Debug-reads like `job-status.mjs` are fine.)
4. **Confirm before `--count` > 5.** ~20-25 credits per video at `std`, more
   at `pro`. `--dry-run` previews the plan and cost, spends nothing.
5. If `RESULT.ok` is false, read `RESULT.error`. An auth error means the USER
   must run `higgsfield auth login` — tell them, wait, then re-run the same
   command.
6. If a script was killed/interrupted, nothing is lost: the queue is on disk.
   Just run `node scripts/check.mjs`.

### make-videos.mjs flags

- `--mode std` — cheaper 720p mode (default is `pro`, 1080p, from config).
- `--clip <path>` — force a specific motion clip (default: random from pool).
- `--prompt "<text>"` — full custom image prompt, skips the outfit database.
- `--extra-prompt "<text>"` — append scene/vibe/lighting on top of the random
  outfit ("at the beach", "golden hour", "wearing sunglasses").
- `--force` — allow submitting while the same character still has pending videos.
- `--dry-run` — plan + cost preview, spends nothing.

### Control model (if the user asks "can I add a prompt to the video?")

WHO = `--character` (trained Soul ID). WHAT they wear = random outfit (or
`--prompt`). WHERE/lighting/vibe = `--extra-prompt`. HOW they move = the clip.
Kling Motion Control takes NO text prompt on this API — all look direction
goes on the image step; the motion comes from the clip.

### Failures

`check.mjs` reports `failed_now[]`; the full log is `output/failures.json`.
Each failure has `stage`, `error_type`, `status`, `retryable`, and job ids.

- `nsfw` / `content_blocked`: Higgsfield's content filter blocked that ONE
  generation. Not a bug — report it plainly, don't retry the same prompt
  (a softer outfit/scene wording may pass).
- `retryable: true` failures may be resubmitted with `make-videos.mjs`
  (add `--force` if the character still has other pending videos).
- One failure never stops the rest of the batch.

## Direct method ("second method") — ONLY on explicit request

When the user explicitly says "use the second method" / "direct method" /
"the RUN ME.bat way", replace the submit+check loop with ONE blocking command:

```bash
node scripts/run-direct.mjs --character "<name>" --count <N>
```

Same flags as make-videos.mjs (minus --force/--dry-run). It does each video
start-to-finish in sequence — Soul image, clip upload, Kling render, download —
and BLOCKS 5-20+ minutes PER VIDEO. Run it with the longest timeout your
environment allows and never kill it. Progress is mirrored into the queue, so
if it does get killed, `node scripts/check.mjs` recovers the in-flight videos
(never run check.mjs WHILE run-direct is running — only after it stops).
Without explicit user request, always use the normal submit+check flow.

## Create a character — "train/make a character from these photos"

Training costs credits and takes several minutes. ALWAYS confirm first, and
require 5-20 photos of the SAME person (10+ varied angles is best). Save the
photos into a folder, then:

```bash
node scripts/create-character.mjs --name "<name>" --images <folder>
```

`RESULT` returns `soul_id` and `credits_spent`. Usable in make-videos
immediately (fuzzy-matched by name). Add `--cinematic` only if the user
specifically wants the Soul Cinematic look.

## Status / inventory — "how many credits / what characters do I have?"

```bash
node scripts/status.mjs --json
```

`RESULT` = `{ authenticated, credits, characters[], clips }`.

## Dashboard — "show me my videos"

```bash
node scripts/serve-ui.mjs
```

Keep it running (background); tell the user to open http://localhost:7788.
Read-only, never spends credits.

## Debugging a single Higgsfield job (rarely needed)

```bash
node scripts/job-status.mjs --job <job_id>   # one job
node scripts/job-status.mjs --recent 20      # recent video jobs
```

The normal flow never needs this — `check.mjs` already tracks every queued
job in `output/queue.json`. Use it only for forensics on a specific job id.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Session expired` / `Not authenticated` / credits null | Browser machine: user runs `higgsfield auth login`. Headless machine: credentials import (see `auth_login` above) — never relay the long OAuth URL. |
| `higgsfield` not found | `npm install -g @higgsfield/cli` (onboard tries this). Windows tar error → set `HIGGSFIELD_BIN` to the hf.exe path. |
| Videos "taking forever" | Normal — renders take minutes. Run `check.mjs` every ~2 minutes; it reports per-item progress. |
| make-videos refuses: "already has pending video(s)" | Working as intended. Run `check.mjs` to collect them; use `--force` only for intentional extra videos. |
| Job status `nsfw` | Content filter blocked that generation. Not a bug; skip or soften wording. |
| Outfit prompt API 500 | Automatic — script falls back to the Firestore prompt database. Only mention if BOTH sources fail. |
| "No motion clips" | Pool is empty; user must add clips to `motion_videos/`. |
| "No trained character matches" | Name typo or none trained; show `status.mjs` character list. |

See README.md for full setup, config keys, and cost details.
