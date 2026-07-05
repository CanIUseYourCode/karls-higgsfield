// Tiny local dashboard for browsing generated videos.
//
//   node scripts/serve-ui.mjs          -> http://localhost:7788
//   node scripts/serve-ui.mjs 8080     -> custom port
//
// Zero dependencies. Read-only: it never spends credits (only reads
// account status / character list for the header, cached).

import { createServer } from "node:http";
import { readFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { ROOT, loadConfig, readManifest, getCredits, listCharacters } from "./lib.mjs";

const cfg = loadConfig();
const port = parseInt(process.argv[2], 10) || cfg.ui_port || 7788;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

let cache = { at: 0, credits: null, characters: [] };
async function headerData() {
  if (Date.now() - cache.at > 60_000) {
    const [credits, characters] = await Promise.all([
      getCredits().catch(() => null),
      listCharacters().then((cs) => cs.filter((c) => c.status === "completed")).catch(() => []),
    ]);
    cache = { at: Date.now(), credits, characters };
  }
  return cache;
}

function sendFile(res, filePath, status = 200, extraHeaders = {}) {
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  const size = statSync(filePath).size;
  res.writeHead(status, { "Content-Type": type, "Content-Length": size, ...extraHeaders });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return sendFile(res, join(ROOT, "ui", "index.html"));
    }

    if (url.pathname === "/api/data") {
      const { credits, characters } = await headerData();
      const body = JSON.stringify({
        credits,
        characters: characters.map((c) => c.name),
        items: readManifest(cfg),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(body);
    }

    if (url.pathname.startsWith("/files/")) {
      const name = decodeURIComponent(url.pathname.slice("/files/".length));
      const filePath = normalize(join(cfg.output_dir, name));
      if (!filePath.startsWith(normalize(cfg.output_dir)) || !existsSync(filePath)) {
        res.writeHead(404); return res.end("not found");
      }
      // basic range support so <video> can seek
      const range = req.headers.range;
      if (range) {
        const size = statSync(filePath).size;
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : size - 1;
          res.writeHead(206, {
            "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
          });
          return createReadStream(filePath, { start, end }).pipe(res);
        }
      }
      return sendFile(res, filePath, 200, { "Accept-Ranges": "bytes" });
    }

    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    res.writeHead(500);
    res.end("server error: " + e.message);
  }
});

server.listen(port, () => {
  console.log(`Higgsfield Factory dashboard -> http://localhost:${port}`);
});
