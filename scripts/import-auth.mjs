// Connect a Higgsfield account on a machine with NO browser (cloud/headless
// agent runtime) by importing the credentials file from a machine that has
// logged in normally.
//
// On the machine WITH a browser (the user's own computer):
//   1. npm install -g @higgsfield/cli
//   2. higgsfield auth login                  (quick browser sign-in)
//   3. Open the file  ~/.higgsfield/credentials.json
//      (Windows: C:\Users\<you>\.higgsfield\credentials.json)
//      and send its contents to the agent.
//
// On THIS machine (headless):
//   node scripts/import-auth.mjs '<pasted JSON>'
//   node scripts/import-auth.mjs --file <saved.json>
//   cat saved.json | node scripts/import-auth.mjs --stdin
//
// The pasted content is a revocable OAuth login token (NOT a password).
// Running `higgsfield auth logout` on either machine invalidates it.
//
// Last line is RESULT:{...} JSON.

import {
  mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getCredits } from "./lib.mjs";

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  console.log("RESULT:" + JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

async function readInput() {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf("--file");
  if (fileIdx !== -1) {
    const p = argv[fileIdx + 1];
    if (!p || !existsSync(p)) fail(`--file path not found: ${p}`);
    return readFileSync(p, "utf8");
  }
  if (argv.includes("--stdin")) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data;
  }
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length) return positional.join(" ");
  fail("No credentials given. Use: import-auth.mjs '<pasted JSON>'  or  --file <path>  or  --stdin");
}

const raw = (await readInput()).trim();
let creds;
try {
  creds = JSON.parse(raw);
} catch {
  fail("That doesn't parse as JSON. Paste the EXACT contents of credentials.json (starts with '{').");
}
if (typeof creds !== "object" || creds === null || Array.isArray(creds)) {
  fail("Expected a JSON object — the contents of credentials.json.");
}

const dir = join(homedir(), ".higgsfield");
mkdirSync(dir, { recursive: true });
const target = join(dir, "credentials.json");
if (existsSync(target)) copyFileSync(target, target + ".bak");
writeFileSync(target, JSON.stringify(creds, null, 2));
console.log(`Wrote ${target}`);

const credits = await getCredits();
if (credits === null) {
  fail("Credentials written, but Higgsfield rejected them (or the CLI is not installed here). Make sure the source machine is FRESHLY logged in (`higgsfield auth login`), re-copy credentials.json, and try again.");
}
console.log(`Connected. Credits: ${credits}`);
console.log("RESULT:" + JSON.stringify({
  ok: true,
  credits,
  next: "Run: node scripts/onboard.mjs --json  (should now show authenticated:true)",
}));
