// Quick account + inventory status. Read-only, spends nothing.
//
//   node scripts/status.mjs          human-readable
//   node scripts/status.mjs --json   machine-readable (last line RESULT:{...})

import { existsSync, readdirSync } from "node:fs";
import { loadConfig, getCredits, listCharacters } from "./lib.mjs";

const jsonMode = process.argv.includes("--json");
const cfg = loadConfig();

const credits = await getCredits();
const authenticated = credits !== null;
let characters = [];
if (authenticated) {
  try {
    characters = (await listCharacters())
      .filter((c) => c.status === "completed")
      .map((c) => ({ name: c.name, id: c.id }));
  } catch { /* ignore */ }
}
const clips = existsSync(cfg.motion_dir)
  ? readdirSync(cfg.motion_dir).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).length : 0;

const result = { authenticated, credits, characters, clips };

if (!jsonMode) {
  if (!authenticated) {
    console.log("Not connected to Higgsfield. Run: higgsfield auth login");
  } else {
    console.log(`Credits: ${credits}`);
    console.log(`Characters (${characters.length}): ${characters.map((c) => c.name).join(", ") || "none"}`);
    console.log(`Motion clips in pool: ${clips}`);
  }
}
console.log("RESULT:" + JSON.stringify(result));
process.exit(authenticated ? 0 : 2);
