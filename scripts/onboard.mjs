// First-run onboarding. Safe to run any time (idempotent).
//
//   node scripts/onboard.mjs
//
// Exit codes: 0 = fully ready, 2 = user action needed (details printed).

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, loadConfig, ensureDirs, findHiggsfieldBin, getCredits, listCharacters,
} from "./lib.mjs";

let needsAction = false;
const say = (s) => console.log(s);

say("=== Higgsfield Factory — setup check ===\n");

// 1) config
if (!existsSync(join(ROOT, "config.json"))) {
  copyFileSync(join(ROOT, "config.default.json"), join(ROOT, "config.json"));
  say("[ok] created config.json from defaults (edit it to customize)");
} else {
  say("[ok] config.json present");
}
const cfg = loadConfig();

// 2) folders
ensureDirs(cfg);
say(`[ok] folders ready:\n     motion clips -> ${cfg.motion_dir}\n     results      -> ${cfg.output_dir}`);

// 3) Higgsfield CLI
let bin = findHiggsfieldBin();
if (!bin) {
  say("[..] Higgsfield CLI not found — attempting install (npm install -g @higgsfield/cli)...");
  const r = spawnSync("npm", ["install", "-g", "@higgsfield/cli"], {
    encoding: "utf8", shell: process.platform === "win32",
  });
  bin = findHiggsfieldBin();
  if (!bin) {
    needsAction = true;
    say("[!!] Could not install the Higgsfield CLI automatically.");
    say("     Please run:  npm install -g @higgsfield/cli");
    if (r.stderr) say("     Installer said: " + r.stderr.split("\n").slice(-3).join(" "));
  }
}
if (bin) say(`[ok] Higgsfield CLI found (${bin})`);

// 4) authentication
if (bin) {
  const credits = await getCredits();
  if (credits === null) {
    needsAction = true;
    say("[!!] Not connected to a Higgsfield account yet.");
    say("     Run this in a terminal on this machine:  higgsfield auth login");
    say("     (it opens a browser for a 5-second sign-in — no API key needed)");
    say("     Headless server? Run over SSH with port forwarding first:");
    say("       ssh -L 8765:localhost:8765 <user>@<server>   then run the login there");
  } else {
    say(`[ok] Higgsfield account connected — ${credits} credits available`);

    // 5) characters
    try {
      const chars = (await listCharacters()).filter((c) => c.status === "completed");
      if (chars.length) {
        say(`[ok] ${chars.length} trained character(s): ${chars.map((c) => c.name).join(", ")}`);
      } else {
        say("[..] No trained characters yet. Create one with:");
        say('     node scripts/create-character.mjs --name "Mia" --images <folder with 5-20 photos>');
      }
    } catch (e) {
      say("[!!] Could not list characters: " + e.message);
    }
  }
}

// 6) motion clips
const clips = existsSync(cfg.motion_dir)
  ? readdirSync(cfg.motion_dir).filter((f) => /\.(mp4|mov|webm)$/i.test(f)) : [];
if (clips.length) {
  say(`[ok] ${clips.length} motion clip(s) in the pool`);
} else {
  say(`[..] Motion clip pool is empty — drop .mp4 files into: ${cfg.motion_dir}`);
  say("     (Optional: make a subfolder named after a character for character-specific clips)");
}

say("");
if (needsAction) {
  say("=> Setup needs the action(s) marked [!!] above, then run this again.");
  process.exit(2);
} else {
  say("=> Ready. Try:  node scripts/make-videos.mjs --character \"<name>\" --count 1 --dry-run");
  process.exit(0);
}
