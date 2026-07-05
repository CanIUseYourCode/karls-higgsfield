# Higgsfield Factory

A reusable agent skill for **MaxAgents / OpenClaw** that turns a Higgsfield
subscription into an automated character-video factory:

> **"Hey Max, make 3 videos of Mia Lin"**

…and the agent will, for each video:

1. Fetch a random outfit prompt (from an [outfit-extractor](https://outfit-extractor.vercel.app) API, with automatic Firestore fallback)
2. Generate a **Soul 2.0** image of that character wearing it (9:16)
3. Pick a random motion clip from your pool and run **Kling 3.0 Motion Control**
4. Download the finished MP4 and hand it back

It also trains new Soul characters from a folder of photos, and ships a local
web dashboard to browse everything that's been generated.

Uses the official [Higgsfield CLI](https://higgsfield.ai/cli) — your normal
account login and plan credits. No API keys, no scraping.

## Install (MaxAgents / OpenClaw)

Clone into your agent's skills folder:

```bash
git clone https://github.com/<you>/higgsfield-factory <skills-dir>/higgsfield-factory
```

(`<skills-dir>` is typically `~/.openclaw/skills` or your workspace `skills/`
folder — wherever your MaxAgents install discovers skills.)

Requirements on the machine where the agent runs: **Node 18+** and npm.

## Onboarding

Ask the agent to "set up Higgsfield", or run manually:

```bash
node scripts/onboard.mjs
```

It installs the Higgsfield CLI if missing, creates the folders, and tells you
the one thing only you can do: **connect your Higgsfield account**:

```bash
higgsfield auth login
```

That opens a browser for a 5-second sign-in. On a **headless server**, tunnel
the OAuth callback port from a machine with a browser first:

```bash
ssh -L 8765:localhost:8765 user@server
# then run `higgsfield auth login` on the server and open the printed URL locally
```

Finally, drop motion clips (`.mp4`/`.mov`/`.webm`) into `motion_videos/`.
A subfolder named after a character (e.g. `motion_videos/Mia Lin/`) becomes
that character's private clip pool; everything else is shared.

## Usage

| You say | The agent runs |
|---|---|
| "make 1 video of Mia" | `node scripts/make-videos.mjs --character "Mia" --count 1` |
| "make 5 pro videos of yumi" | `node scripts/make-videos.mjs --character yumi --count 5 --mode pro` |
| "how much would 10 videos cost?" | same with `--dry-run` (spends nothing) |
| "create a character called Ana from these photos" | `node scripts/create-character.mjs --name "Ana" --images <folder>` |
| "show me the dashboard" | `node scripts/serve-ui.mjs` → http://localhost:7788 |

Results land in `output/` (MP4 + the Soul reference image + `manifest.json`).

## Dashboard

```bash
node scripts/serve-ui.mjs        # http://localhost:7788
```

Dark-mode gallery of every generated video: play inline, filter by character,
download, live credit balance. Read-only — it never spends credits.

## Configuration (`config.json`)

Created from `config.default.json` on first onboard. Notable keys:

| key | default | meaning |
|---|---|---|
| `aspect_ratio` | `9:16` | Soul image ratio |
| `mode` | `std` | Kling quality (`std`/`pro`) |
| `max_videos_per_request` | `10` | hard cap per request |
| `credit_floor` | `25` | refuse to start below this balance |
| `prompt_api` | outfit-extractor URL | primary prompt source (text/plain) |
| `prompt_preset` | `""` | text prepended to Firestore-fallback prompts |
| `background_source` | `input_image` | keep image's background, or `input_video` |

## Safety rails

- Batch size hard-capped per request; agent confirms anything over 5.
- Credit floor stops runs before the account is drained.
- Training a character always requires explicit user confirmation (it costs credits).
- Login is always done by the human in a browser — the agent never touches passwords.

## Credits & costs

- Soul 2.0 image: ~0.12 credits each
- Kling 3.0 Motion Control: billed by clip length and mode — run one video and
  check `higgsfield account status` to calibrate your plan.
