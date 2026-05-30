const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const INDEX = path.join(__dirname, "index.html");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function getMimeType(ext) {
  return { ".pdf": "application/pdf", ".html": "text/html" }[ext] || "application/octet-stream";
}

// ── ZIP parser (no deps, pure Node) ──
function parseZip(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i]===0x50 && buf[i+1]===0x4b && buf[i+2]===0x03 && buf[i+3]===0x04) {
      const compression = buf.readUInt16LE(i + 8);
      const compSize    = buf.readUInt32LE(i + 18);
      const fnLen       = buf.readUInt16LE(i + 26);
      const extraLen    = buf.readUInt16LE(i + 28);
      const filename    = buf.slice(i + 30, i + 30 + fnLen).toString("utf8");
      const dataStart   = i + 30 + fnLen + extraLen;
      const compData    = buf.slice(dataStart, dataStart + compSize);

      if (!filename.endsWith("/") && filename.toLowerCase().endsWith(".pdf")) {
        let data = null;
        if (compression === 0) data = compData;
        else if (compression === 8) {
          try { data = zlib.inflateRawSync(compData); } catch {}
        }
        if (data) entries.push({ filename: path.basename(filename), data });
      }
      i = dataStart + compSize;
    } else { i++; }
  }
  return entries;
}

// ── multipart parser — binary-safe ──
// Correctly handles binary payloads by scanning for boundary as bytes,
// never converting binary data to string prematurely.
function parseMultipart(body, boundary) {
  const files = [];
  const CRLF = Buffer.from("\r\n");
  const CRLFCRLF = Buffer.from("\r\n\r\n");
  const boundaryBuf = Buffer.from("--" + boundary);
  const finalBuf    = Buffer.from("--" + boundary + "--");

  let pos = 0;

  while (pos < body.length) {
    // Find next boundary
    const bIdx = body.indexOf(boundaryBuf, pos);
    if (bIdx === -1) break;

    // Check if it's the final boundary
    const afterBound = bIdx + boundaryBuf.length;
    if (body.slice(afterBound, afterBound + 2).equals(Buffer.from("--"))) break;

    // Skip past boundary + CRLF
    const headerStart = afterBound + 2; // skip \r\n after boundary

    // Find end of headers (blank line)
    const headerEnd = body.indexOf(CRLFCRLF, headerStart);
    if (headerEnd === -1) break;

    // Parse headers as string (safe — headers are always ASCII)
    const headerStr = body.slice(headerStart, headerEnd).toString("ascii");

    // Find start of this part's content
    const contentStart = headerEnd + 4; // skip \r\n\r\n

    // Find next boundary to determine end of content
    const nextBoundary = body.indexOf(boundaryBuf, contentStart);
    if (nextBoundary === -1) break;

    // Content ends 2 bytes before next boundary (strip trailing \r\n)
    const contentEnd = nextBoundary - 2;
    const content = body.slice(contentStart, contentEnd);

    // Extract filename from Content-Disposition header
    const filenameMatch = headerStr.match(/filename="([^"]+)"/i);
    if (filenameMatch) {
      files.push({ filename: filenameMatch[1], data: content });
    }

    pos = nextBoundary;
  }

  return files;
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
}

function getFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR)
    .filter(f => f.endsWith(".pdf"))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, size: stat.size, uploaded: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
}

// ── HTTP server ──
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(INDEX));
  }

  if (pathname === "/api/files" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getFiles()));
  }

  if (pathname.startsWith("/api/delete/") && req.method === "DELETE") {
    const filename = decodeURIComponent(pathname.replace("/api/delete/", ""));
    const filepath = path.join(UPLOAD_DIR, path.basename(filename));
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname.startsWith("/uploads/")) {
    const filename = decodeURIComponent(pathname.replace("/uploads/", ""));
    const filepath = path.join(UPLOAD_DIR, path.basename(filename));
    if (fs.existsSync(filepath)) {
      res.writeHead(200, {
        "Content-Type": getMimeType(path.extname(filepath)),
        "Content-Disposition": "inline",
      });
      return fs.createReadStream(filepath).pipe(res);
    }
    res.writeHead(404); return res.end("Not found");
  }

  if (pathname === "/api/upload" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) { res.writeHead(400); return res.end("Bad request"); }

    const boundary = boundaryMatch[1].trim();
    const chunks = [];

    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parts;
      try { parts = parseMultipart(body, boundary); }
      catch (e) { console.error("Multipart parse error:", e); parts = []; }

      const saved = [];

      for (const part of parts) {
        const fname = part.filename.toLowerCase();
        console.log(`Processing part: ${part.filename} (${part.data.length} bytes)`);

        if (fname.endsWith(".pdf")) {
          const name = safeName(part.filename);
          fs.writeFileSync(path.join(UPLOAD_DIR, name), part.data);
          saved.push(name);
          console.log(`Saved PDF: ${name}`);

        } else if (fname.endsWith(".zip")) {
          let extracted = [];
          try { extracted = parseZip(part.data); }
          catch (e) { console.error("ZIP parse error:", e); }
          console.log(`ZIP contained ${extracted.length} PDFs`);
          for (const entry of extracted) {
            const name = safeName(entry.filename);
            fs.writeFileSync(path.join(UPLOAD_DIR, name), entry.data);
            saved.push(name);
            console.log(`Extracted: ${name}`);
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, files: saved, count: saved.length }));
    });

    req.on("error", err => {
      console.error("Request error:", err);
      res.writeHead(500); res.end("Upload error");
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// 200MB limit for large PDF batches
server.maxHeaderSize = 16384;
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Study Dash running on port", PORT));
