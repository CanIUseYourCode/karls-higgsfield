---
name: higgsfield-factory
description: >
  Make AI character videos on Higgsfield: random outfit prompt -> Soul 2.0
  character image -> Kling 3.0 Motion Control with a motion clip -> MP4.
  Use when the user asks to "make/generate N video(s) of <character>",
  create/train a new character from photos, list characters, check Higgsfield
  credits, set up/connect a Higgsfield account, or open the video dashboard.
---

# Higgsfield Factory

All commands run from this skill's folder. Scripts print human progress lines,
and the LAST line is machine-readable: `RESULT:{...}` — parse that for outcome.

## First contact / onboarding

If this is the first use (or anything fails with auth/setup errors), run:

```bash
node scripts/onboard.mjs
```

- Exit 0 → ready.
- Exit 2 → the output lists `[!!]` actions ONLY THE USER can do. Relay them
  verbatim — most commonly connecting their Higgsfield account:
  `higgsfield auth login` (opens a browser; the user must do this themselves,
  never handle their password). Then re-run onboarding to confirm.

## "Make N videos of <character>"

```bash
node scripts/make-videos.mjs --character "<name>" --count <N>
```

Rules:
- Character names are fuzzy-matched ("mia" → "Mia Lin"). If RESULT says no
  match, show the available names it lists and ask the user to pick.
- N > 5: confirm with the user first — video generation burns credits fast.
- Never raise `max_videos_per_request` or lower `credit_floor` in config.json
  unless the user explicitly asks.
- Optional flags: `--mode pro` (higher quality), `--clip <path>` (specific
  motion clip instead of random), `--prompt "<text>"` (skip the outfit API),
  `--dry-run` (plan + cost preview, spends nothing — use it when the user
  seems unsure or asks "how much would X cost").
- On success, RESULT lists the finished MP4 paths in `made[]` — send the
  video file(s) back to the user in the chat, plus one line: how many made,
  credits spent, credits left.
- Motion clips live in the `motion_videos/` folder (a subfolder named after a
  character = that character's private clip pool). If RESULT says the pool is
  empty, ask the user to add .mp4 clips there — that's a user action.

## "Create/train a character" (from photos)

Training costs credits and takes minutes. ALWAYS confirm with the user before
starting, and tell them you need 5–20 photos of the same person (10+ from
different angles is best). Photos must already be in a folder on this machine
(the user can send them in chat first — save them to a folder).

```bash
node scripts/create-character.mjs --name "<name>" --images <folder>
```

RESULT gives `soul_id` and `credits_spent`. Afterwards the character works in
make-videos immediately.

## "List characters" / "check credits"

```bash
higgsfield soul-id list
higgsfield account status
```

## Dashboard UI

```bash
node scripts/serve-ui.mjs
```

Then tell the user to open http://localhost:7788 — a gallery of every
generated video with character filter, credits, and downloads. Keep it
running in the background; it's read-only and never spends credits.

## Troubleshooting

- `Session expired` / `Not authenticated` → user must run `higgsfield auth login`.
- `higgsfield` not found → `npm install -g @higgsfield/cli` (onboard.mjs tries
  this automatically). On Windows, if npm's postinstall fails with a tar error,
  set `HIGGSFIELD_BIN` to the full path of `hf.exe`.
- Outfit prompt API down → the script automatically falls back to the Firestore
  prompt database; no action needed. Mention it only if both sources fail.
- A single video failing does not stop the batch; check RESULT.failed.
