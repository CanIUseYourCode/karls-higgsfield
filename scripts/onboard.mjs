// Setup check + onboarding state. Safe to run any time (idempotent, spends nothing).
//
//   node scripts/onboard.mjs          human-readable checklist
//   node scripts/onboard.mjs --json   machine-readable state for agents (last line RESULT:{...})
//
// Exit codes: 0 = fully ready, 2 = user action needed (see next_steps).
//
// RESULT shape:
// {
//   ready: bool,
//   cli_installed: bool,
//   authenticated: bool,
//   credits: number|null,
//   characters: [{name, id}],
//   clips: number,               // motion clips in the pool
//   folders: { motion_dir, output_dir },
//   next_steps: [ { id, who, action } ]   // ordered; who = "user" | "agent"
// }

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, loadConfig, ensureDirs, findHiggsfieldBin, getCredits, listCharacters,
} from "./lib.mjs";

const jsonMode = process.argv.includes("--json");
const say = (s) => { if (!jsonMode) console.log(s); };

const SKILL_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const state = {
  ready: false,
  skill_version: SKILL_VERSION,
  cli_installed: false,
  authenticated: false,
  credits: null,
  characters: [],
  clips: 0,
  folders: {},
  next_steps: [],
};

say(`=== Higgsfield Factory — setup check (skill v${SKILL_VERSION}) ===\n`);

// 1) config + folders (agent-fixable, always succeeds)
if (!existsSync(join(ROOT, "config.json"))) {
  copyFileSync(join(ROOT, "config.default.json"), join(ROOT, "config.json"));
  say("[ok] created config.json from defaults");
} else {
  say("[ok] config.json present");
}
const cfg = loadConfig();
ensureDirs(cfg);
state.folders = { motion_dir: cfg.motion_dir, output_dir: cfg.output_dir };
say(`[ok] folders ready:\n     motion clips -> ${cfg.motion_dir}\n     results      -> ${cfg.output_dir}`);

// 2) Higgsfield CLI (agent attempts install automatically)
let bin = findHiggsfieldBin();
if (!bin) {
  say("[..] Higgsfield CLI not found — attempting install (npm install -g @higgsfield/cli)...");
  spawnSync("npm", ["install", "-g", "@higgsfield/cli"], {
    encoding: "utf8", shell: process.platform === "win32",
  });
  bin = findHiggsfieldBin();
}
state.cli_installed = Boolean(bin);
if (bin) {
  say(`[ok] Higgsfield CLI found (${bin})`);
} else {
  say("[!!] Higgsfield CLI could not be installed automatically.");
  say("     Run manually:  npm install -g @higgsfield/cli");
  say("     Windows tar error? Set HIGGSFIELD_BIN to the full path of hf.exe.");
  state.next_steps.push({
    id: "install_cli",
    who: "user",
    action: "Run: npm install -g @higgsfield/cli  (needs Node 18+). If it fails on Windows with a tar error, see Troubleshooting in README.md.",
  });
}

// 3) account authentication (user-only step — browser sign-in)
if (bin) {
  state.credits = await getCredits();
  state.authenticated = state.credits !== null;
  if (state.authenticated) {
    say(`[ok] Higgsfield account connected — ${state.credits} credits available`);
  } else {
    say("[!!] No Higgsfield account connected on this machine.");
    say("     Machine WITH a browser: run  higgsfield auth login  (5-second sign-in).");
    say("     HEADLESS/CLOUD machine: do NOT run auth login here — the long URL it");
    say("     prints redirects to localhost on THIS machine and can never complete");
    say("     from the user's browser. Use the credentials import instead:");
    say("       user logs in on their own computer, sends ~/.higgsfield/credentials.json,");
    say("       agent runs:  node scripts/import-auth.mjs '<pasted JSON>'");
    state.next_steps.push({
      id: "auth_login",
      who: "user",
      action: "If THIS machine can open a browser: run `higgsfield auth login` and sign in — done. If this is a HEADLESS/CLOUD machine (typical agent runtime): DO NOT run auth login here and NEVER send the user the long OAuth URL it prints (its localhost redirect cannot complete remotely). Instead ask the user to do this on their own computer: 1) npm install -g @higgsfield/cli  2) higgsfield auth login  3) open the file ~/.higgsfield/credentials.json (Windows: C:\\Users\\<you>\\.higgsfield\\credentials.json) and paste its contents to you. Then run: node scripts/import-auth.mjs '<pasted JSON>' and re-run onboarding. The paste is a revocable login token, not a password.",
    });
  }
}

// 4) trained characters (informational — videos need at least one)
if (state.authenticated) {
  try {
    state.characters = (await listCharacters())
      .filter((c) => c.status === "completed")
      .map((c) => ({ name: c.name, id: c.id }));
    if (state.characters.length) {
      say(`[ok] ${state.characters.length} trained character(s): ${state.characters.map((c) => c.name).join(", ")}`);
    } else {
      say("[..] No trained characters yet.");
      state.next_steps.push({
        id: "create_character",
        who: "user",
        action: "Provide 5-20 photos of the person (10+ from different angles is best) and a character name; the agent then runs create-character.mjs. Training costs credits — the agent must confirm before starting.",
      });
    }
  } catch (e) {
    say("[!!] Could not list characters: " + e.message);
  }
}

// 5) motion clip pool (user supplies the clips)
const clipFiles = existsSync(cfg.motion_dir)
  ? readdirSync(cfg.motion_dir).filter((f) => /\.(mp4|mov|webm)$/i.test(f)) : [];
state.clips = clipFiles.length;
if (state.clips > 0) {
  say(`[ok] ${state.clips} motion clip(s) in the pool`);
} else {
  say(`[..] Motion clip pool is empty: ${cfg.motion_dir}`);
  say("     Add .mp4/.mov/.webm clips whose MOVEMENT you want characters to copy.");
  state.next_steps.push({
    id: "add_motion_clips",
    who: "user",
    action: `Send the agent (or drop into ${cfg.motion_dir}) one or more short video clips whose movement should be copied — e.g. a dance or pose video. A subfolder named after a character makes clips exclusive to that character.`,
  });
}

// verdict
state.ready = state.cli_installed && state.authenticated
  && state.characters.length > 0 && state.clips > 0;

say("");
if (state.ready) {
  say('=> READY. Try:  node scripts/make-videos.mjs --character "' + state.characters[0].name + '" --count 1 --dry-run');
} else {
  say("=> Not ready yet — steps needed:");
  state.next_steps.forEach((s, i) => say(`   ${i + 1}. [${s.who}] ${s.action}`));
}
console.log("RESULT:" + JSON.stringify(state));
process.exit(state.ready ? 0 : 2);
