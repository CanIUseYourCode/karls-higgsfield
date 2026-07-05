// Shared helpers for the higgsfield-factory skill.
// Zero dependencies. Requires Node 18+ (global fetch).

import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
} from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- config ----------

export function loadConfig() {
  const base = JSON.parse(readFileSync(join(ROOT, "config.default.json"), "utf8"));
  const customPath = join(ROOT, "config.json");
  if (existsSync(customPath)) {
    Object.assign(base, JSON.parse(readFileSync(customPath, "utf8")));
  }
  base.motion_dir = isAbsolute(base.motion_dir) ? base.motion_dir : join(ROOT, base.motion_dir);
  base.output_dir = isAbsolute(base.output_dir) ? base.output_dir : join(ROOT, base.output_dir);
  return base;
}

export function ensureDirs(cfg) {
  mkdirSync(cfg.motion_dir, { recursive: true });
  mkdirSync(cfg.output_dir, { recursive: true });
}

// ---------- higgsfield CLI ----------

let cachedBin = null;

export function findHiggsfieldBin() {
  if (cachedBin) return cachedBin;
  const candidates = [];
  if (process.env.HIGGSFIELD_BIN) candidates.push(process.env.HIGGSFIELD_BIN);
  if (process.platform === "win32" && process.env.APPDATA) {
    // npm shim spawns this exe; calling it directly avoids .cmd quoting issues
    candidates.push(join(process.env.APPDATA, "npm", "node_modules", "@higgsfield", "cli", "vendor", "hf.exe"));
  }
  candidates.push("higgsfield", "hf");
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["version"], { encoding: "utf8" });
      if (r.status === 0) { cachedBin = c; return c; }
    } catch { /* try next */ }
  }
  return null;
}

export function hf(args, { timeoutMs = 40 * 60 * 1000 } = {}) {
  const bin = findHiggsfieldBin();
  if (!bin) {
    return Promise.reject(new Error(
      "Higgsfield CLI not found. Install it with: npm install -g @higgsfield/cli " +
      "(or set HIGGSFIELD_BIN to the binary path), then run: higgsfield auth login"
    ));
  }
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectP(new Error(`higgsfield ${args.slice(0, 3).join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); rejectP(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) rejectP(new Error((err || out || `exit code ${code}`).trim()));
      else resolveP(out.trim());
    });
  });
}

export function parseJob(jsonText) {
  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

export async function getCredits() {
  try {
    const status = await hf(["account", "status"], { timeoutMs: 60_000 });
    const m = status.match(/([\d.]+)\s+credits/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

export async function isAuthenticated() {
  try {
    await hf(["account", "status"], { timeoutMs: 60_000 });
    return true;
  } catch (e) {
    if (/not authenticated|session expired|login/i.test(String(e.message))) return false;
    throw e;
  }
}

// ---------- soul characters ----------

export async function listCharacters() {
  const out = await hf(["soul-id", "list", "--json"], { timeoutMs: 60_000 });
  const parsed = JSON.parse(out);
  const arr = Array.isArray(parsed) ? parsed : (parsed.items || parsed.data || []);
  return arr.map((c) => ({
    id: c.id,
    name: c.name || c.display_name || "",
    status: c.status || "",
    type: c.type || "",
  }));
}

// Fuzzy-match a user-supplied name ("Mia") against trained characters.
// Returns { chosen, alternates, all } — chosen is null when nothing matches.
export async function resolveCharacter(query) {
  const all = (await listCharacters()).filter((c) => c.status === "completed");
  const q = query.trim().toLowerCase();
  const exact = all.filter((c) => c.name.toLowerCase() === q);
  const starts = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const includes = all.filter((c) => c.name.toLowerCase().includes(q));
  const pool = exact.length ? exact : (starts.length ? starts : includes);
  if (pool.length === 0) return { chosen: null, alternates: [], all };
  // shortest name = most canonical ("Mia Lin" over "Mia Lin 001")
  const sorted = [...pool].sort((a, b) => a.name.length - b.name.length);
  return { chosen: sorted[0], alternates: sorted.slice(1), all };
}

// ---------- outfit prompts ----------

function fsValue(v) {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsValue);
  if ("mapValue" in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = fsValue(val);
    return o;
  }
  return v;
}

async function fetchPromptFromApi(cfg) {
  const r = await fetch(cfg.prompt_api, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`prompt API HTTP ${r.status}`);
  const text = (await r.text()).trim();
  if (!text || /server error|FUNCTION_INVOCATION_FAILED/i.test(text)) {
    throw new Error("prompt API returned an error page");
  }
  return text;
}

async function fetchPromptsFromFirestore(cfg, n) {
  const fs = cfg.firestore_fallback;
  const r = await fetch(fs.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: fs.collection }],
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
        limit: fs.limit || 150,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Firestore fallback HTTP ${r.status}`);
  const rows = (await r.json()).filter((x) => x.document);
  if (!rows.length) throw new Error("no saved prompts found in the outfit database");
  // shuffle, then take n distinct docs (repeat if fewer docs than n)
  const shuffled = rows.sort(() => Math.random() - 0.5);
  const picks = [];
  for (let i = 0; i < n; i++) picks.push(shuffled[i % shuffled.length]);
  return picks.map((row) => {
    const f = row.document.fields || {};
    const initial = fsValue(f.initialPrompt) || "";
    let outfitJson = "";
    try {
      const parsed = fsValue(f.jsonResult);
      const outfit = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
      outfitJson = JSON.stringify(outfit);
    } catch { /* prompt still usable without outfit JSON */ }
    return [cfg.prompt_preset, initial, outfitJson ? `Outfit details: ${outfitJson}` : ""]
      .filter(Boolean).join("\n\n");
  });
}

// Returns { source, prompts: string[] } with n prompts.
export async function fetchOutfitPrompts(cfg, n) {
  const prompts = [];
  try {
    for (let i = 0; i < n; i++) prompts.push(await fetchPromptFromApi(cfg));
    return { source: "api", prompts };
  } catch {
    return { source: "firestore", prompts: await fetchPromptsFromFirestore(cfg, n) };
  }
}

// ---------- motion clips ----------

const CLIP_EXT = /\.(mp4|mov|webm)$/i;

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function listClips(cfg, characterName) {
  const dirs = [];
  if (characterName) {
    dirs.push(join(cfg.motion_dir, characterName));
    dirs.push(join(cfg.motion_dir, slug(characterName)));
  }
  dirs.push(cfg.motion_dir);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const clips = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && CLIP_EXT.test(e.name))
      .map((e) => join(dir, e.name));
    if (clips.length) return clips;
  }
  return [];
}

export function pickClip(cfg, characterName) {
  const clips = listClips(cfg, characterName);
  if (!clips.length) return null;
  return clips[Math.floor(Math.random() * clips.length)];
}

// ---------- output manifest ----------

export function manifestPath(cfg) {
  return join(cfg.output_dir, "manifest.json");
}

export function readManifest(cfg) {
  const p = manifestPath(cfg);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

export function appendManifest(cfg, entry) {
  const list = readManifest(cfg);
  list.unshift(entry);
  writeFileSync(manifestPath(cfg), JSON.stringify(list, null, 2));
}

// ---------- downloads ----------

export async function download(url, filePath) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!r.ok) throw new Error(`download failed HTTP ${r.status}`);
  writeFileSync(filePath, Buffer.from(await r.arrayBuffer()));
  return filePath;
}
