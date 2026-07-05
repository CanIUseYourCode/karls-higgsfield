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

You (the agent) drive a local pipeline via small Node scripts. Every script
prints human progress lines, and its LAST line is `RESULT:{...}` JSON — always
parse that line for the outcome; never scrape the prose.

- Run all commands from THIS skill's folder. Node 18+ required.
- Scripts that spend credits: `make-videos.mjs`, `create-character.mjs`.
  Everything else is free/read-only.
- The user's Higgsfield password is NEVER handled by you. Account connection is
  always the user running `higgsfield auth login` in their own browser.

## Golden rule: check readiness first

Before the first video of a session, or whenever anything fails with a
setup/auth error, run:

```bash
node scripts/onboard.mjs --json
```

Parse `RESULT`. If `ready` is true, proceed. If false, walk the user through
`next_steps` IN ORDER. Each step has `who`:
- `who: "user"` → you cannot do it; relay `action` in plain language and wait.
- `who: "agent"` → you can do it (rare; onboarding self-heals most agent steps).

Do not attempt to generate a video until `ready` is true.

### Onboarding conversation (what to say)

Map each `next_steps.id` to a friendly ask:

- `install_cli` → "I need the Higgsfield CLI installed. Want me to run
  `npm install -g @higgsfield/cli`?" (You may run it.)
- `auth_login` → "Connect your Higgsfield account: open a terminal and run
  `higgsfield auth login` — a browser opens for a quick sign-in. Tell me when
  it's done." Then re-run onboarding to confirm. (Headless server: the step's
  `action` includes the SSH port-forward command — pass it along.)
- `add_motion_clips` → "Send me the video clip(s) whose MOVEMENT you want the
  character to copy (a dance, a walk, a pose). I'll add them to the pool."
  Save received videos into the `motion_videos/` folder (or a subfolder named
  after a character to make them character-specific).
- `create_character` → see "Create a character" below.

Re-run `onboard.mjs --json` after each user action to advance.

## Make videos — "make N videos of <character>"

```bash
node scripts/make-videos.mjs --character "<name>" --count <N>
```

- Character names are fuzzy-matched ("mia" → "Mia Lin"). If `RESULT.ok` is
  false with a no-match error, show the available names it lists and ask.
- **Confirm before N > 5** — video generation burns credits fast (~20-25
  credits per video at std, more at pro). Offer a `--dry-run` estimate first if
  the user is unsure or asks about cost.
- On success, `RESULT.made[]` lists finished `.mp4` paths. Deliver the video(s)
  to the user (attach/send in chat), then one line: how many made, credits
  spent, credits left.
- If `RESULT.failed > 0`, report which failed. A single failure never stops the
  batch. **A job status of `nsfw` means Higgsfield's content filter blocked
  that specific generation** — it's not a bug; tell the user plainly and move on.

Useful flags:
- `--mode pro` — higher quality, more credits (default `std`).
- `--clip <path>` — force a specific motion clip (default: random from pool).
- `--prompt "<text>"` — full custom image prompt, skips the outfit database.
- `--extra-prompt "<text>"` — append scene/vibe/lighting direction on top of the
  random outfit. Use when the user adds wishes: "at the beach", "golden hour",
  "wearing sunglasses". (A realism default is already set in config.)
- `--dry-run` — plan + cost preview, spends nothing.

Control model (explain to users if they ask "can I add a prompt to the video?"):
- WHO = the character (`--character`). WHAT they wear = random outfit (or
  `--prompt`). WHERE/lighting/vibe = `--extra-prompt`. HOW they move = the clip.
- Kling Motion Control itself takes NO prompt on this API — all look direction
  goes on the image step. The motion (same camera + character movement) is what
  Motion Control does by default.

## Create a character — "train/make a character from these photos"

Training costs credits and takes several minutes. ALWAYS confirm first, and
require 5-20 photos of the SAME person (10+ from varied angles is best). Have
the user send the photos; save them into a folder, then:

```bash
node scripts/create-character.mjs --name "<name>" --images <folder>
```

`RESULT` returns `soul_id` and `credits_spent`. The character is usable in
make-videos immediately (fuzzy-matched by name). Add `--cinematic` only if the
user specifically wants the Soul Cinematic look.

## Status / inventory — "how many credits / what characters do I have?"

```bash
node scripts/status.mjs --json
```

`RESULT` = `{ authenticated, credits, characters[], clips }`.

## Dashboard — "show me my videos"

```bash
node scripts/serve-ui.mjs
```

Keep it running (background); tell the user to open http://localhost:7788 — a
gallery of every generated video, filterable by character, with downloads and
live credit balance. Read-only, never spends credits.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Session expired` / `Not authenticated` / credits null | User must run `higgsfield auth login`. |
| `higgsfield` not found | `npm install -g @higgsfield/cli` (onboard tries this). Windows tar error → set `HIGGSFIELD_BIN` to the hf.exe path. |
| Video step hangs forever | Old bug — fixed by pre-uploading the clip. Ensure you're on current scripts (they call `upload create` then pass the id). |
| Job status `nsfw` | Content filter blocked that generation. Not a bug; skip it. Softer outfit/scene wording may pass. |
| Outfit prompt API 500 | Automatic — script falls back to the Firestore prompt database. Only mention if BOTH sources fail. |
| "No motion clips" | Pool is empty; user must add clips to `motion_videos/`. |
| "No trained character matches" | Name typo or none trained; show `status.mjs` character list. |

See README.md for full setup, config keys, and cost details.
