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

// ── minimal ZIP parser (no dependencies) ──
// Reads local file headers to extract entries
function parseZip(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length - 4) {
    // Local file header signature: PK\x03\x04
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
      const compression   = buf.readUInt16LE(i + 8);
      const compSize      = buf.readUInt32LE(i + 18);
      const uncompSize    = buf.readUInt32LE(i + 22);
      const fnLen         = buf.readUInt16LE(i + 26);
      const extraLen      = buf.readUInt16LE(i + 28);
      const filename      = buf.slice(i + 30, i + 30 + fnLen).toString("utf8");
      const dataStart     = i + 30 + fnLen + extraLen;
      const compData      = buf.slice(dataStart, dataStart + compSize);

      if (!filename.endsWith("/") && filename.toLowerCase().endsWith(".pdf")) {
        let data;
        if (compression === 0) {
          data = compData; // stored
        } else if (compression === 8) {
          try { data = zlib.inflateRawSync(compData); } catch { data = null; }
        }
        if (data) {
          entries.push({ filename: path.basename(filename), data });
        }
      }
      i = dataStart + compSize;
    } else {
      i++;
    }
  }
  return entries;
}

// ── multipart parser ──
function parseMultipart(body, boundary) {
  const files = [];
  const boundaryBuf = Buffer.from("--" + boundary);
  let start = 0;
  while (start < body.length) {
    const boundaryIdx = body.indexOf(boundaryBuf, start);
    if (boundaryIdx === -1) break;
    const contentStart = boundaryIdx + boundaryBuf.length;
    if (body[contentStart] === 45 && body[contentStart+1] === 45) break;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), contentStart);
    if (headerEnd === -1) break;
    const headers = body.slice(contentStart + 2, headerEnd).toString();
    const nextBoundary = body.indexOf(boundaryBuf, headerEnd);
    const contentData = body.slice(headerEnd + 4, nextBoundary - 2);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (filenameMatch) files.push({ filename: filenameMatch[1], data: contentData });
    start = nextBoundary;
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
    if (fs.existsSync(filepath)) { fs.unlinkSync(filepath); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname.startsWith("/uploads/")) {
    const filename = decodeURIComponent(pathname.replace("/uploads/", ""));
    const filepath = path.join(UPLOAD_DIR, path.basename(filename));
    if (fs.existsSync(filepath)) {
      res.writeHead(200, { "Content-Type": getMimeType(path.extname(filepath)), "Content-Disposition": "inline" });
      return fs.createReadStream(filepath).pipe(res);
    }
    res.writeHead(404); return res.end("Not found");
  }

  if (pathname === "/api/upload" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) { res.writeHead(400); return res.end("Bad request"); }
    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const parts = parseMultipart(body, boundary);
      const saved = [];

      for (const part of parts) {
        const fname = part.filename.toLowerCase();

        if (fname.endsWith(".pdf")) {
          const name = safeName(part.filename);
          fs.writeFileSync(path.join(UPLOAD_DIR, name), part.data);
          saved.push(name);

        } else if (fname.endsWith(".zip")) {
          // Extract PDFs from zip
          let extracted = [];
          try { extracted = parseZip(part.data); } catch (e) { console.error("ZIP parse error", e); }
          for (const entry of extracted) {
            const name = safeName(entry.filename);
            fs.writeFileSync(path.join(UPLOAD_DIR, name), entry.data);
            saved.push(name);
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, files: saved, count: saved.length }));
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Study Dash running on port", PORT));
