# Higgsfield Factory

A reusable **MaxAgents / OpenClaw** skill that turns a Higgsfield subscription
into an automated character-video factory. You talk to your agent in plain
language:

> **"Make 3 videos of Mia Lin"**

…and for each video the agent:

1. Fetches a random outfit prompt (from your [outfit-extractor](https://outfit-extractor.vercel.app) API, with automatic Firestore fallback)
2. Generates a **Soul 2.0** image of that character wearing it (9:16, your realism defaults)
3. Picks a random motion clip from your pool and runs **Kling 3.0 Motion Control**
4. Downloads the finished MP4 and hands it back — and lists it on a local dashboard

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
   - **Headless server?** Tunnel the OAuth callback port from a machine with a
     browser first:
     ```bash
     ssh -L 8765:localhost:8765 user@server
     # then run `higgsfield auth login` on the server, open the printed URL locally
     ```
     The login uses refresh tokens, so the server stays logged in afterward.
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
| "make 1 video of Mia" | `make-videos.mjs --character "Mia" --count 1` |
| "make 5 pro videos of yumi at golden hour" | `make-videos.mjs --character yumi --count 5 --mode pro --extra-prompt "golden hour"` |
| "how much would 10 videos cost?" | same with `--dry-run` (spends nothing) |
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
2. Parse only the last `RESULT:{...}` line from each script.
3. For video generation, store every returned `soul_job` and `kling_job`.
4. Use `node scripts/job-status.mjs --job <job_id>` to detect Higgsfield states:
   `waiting`, `in_progress`, `completed`, `failed`, and `nsfw`.
5. Treat `failed` as the same state shown in the Higgsfield UI card as
   "Generation failed".
6. Use `RESULT.failures[]` or `output/failures.json` to decide retry behavior.

Failure fields include:

| field | meaning |
|---|---|
| `stage` | `image`, `upload`, or `video` |
| `error_type` | `generation_failed`, `content_blocked`, `timeout`, `auth`, `credits`, or `unknown` |
| `status` | Higgsfield job status when known |
| `soul_job` / `kling_job` | Higgsfield ids to inspect or retry |
| `retryable` | false for moderation/auth/credit failures |

Parallel video jobs are supported by Higgsfield. A live test accepted two
Kling 3.0 Motion Control jobs at the same timestamp and both moved to
`in_progress`. Keep the default agent concurrency conservative: start with 2
video jobs at a time, poll with `job-status.mjs`, and increase only after the
account behaves reliably.

---

## How control works

| Dial | Set by |
|---|---|
| **Who** (identity/face) | the character name → its trained Soul ID |
| **What they wear** | random outfit from your database (or `--prompt` to fully override) |
| **Where / lighting / vibe** | `--extra-prompt` (+ the realism default in config) |
| **How they move** | the motion clip |
| **Quality** | `--mode std` (default) or `pro` |

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
| `mode` | `std` | Kling quality (`std` / `pro`) |
| `background_source` | `input_image` | keep the image's background, or `input_video` |
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
| Video generation seems stuck | Ensure you're on current scripts (they upload the clip first, then generate). Renders themselves take a few minutes. |
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
    make-videos.mjs     the pipeline
    create-character.mjs Soul training from photos
    serve-ui.mjs        dashboard server
  ui/index.html         dashboard page
```

## License

MIT — see [LICENSE](LICENSE).
