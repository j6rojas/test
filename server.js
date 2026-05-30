const http = require("http");
const fs = require("fs");
const path = require("path");
const { parse } = require("querystring");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const INDEX = path.join(__dirname, "index.html");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function getMimeType(ext) {
  const types = {
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
  };
  return types[ext] || "application/octet-stream";
}

function parseMultipart(body, boundary) {
  const files = [];
  const boundaryBuf = Buffer.from("--" + boundary);
  const parts = [];
  let start = 0;

  while (start < body.length) {
    const boundaryIdx = body.indexOf(boundaryBuf, start);
    if (boundaryIdx === -1) break;
    const contentStart = boundaryIdx + boundaryBuf.length;
    if (body[contentStart] === 45 && body[contentStart + 1] === 45) break; // --
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), contentStart);
    if (headerEnd === -1) break;
    const headers = body.slice(contentStart + 2, headerEnd).toString();
    const nextBoundary = body.indexOf(boundaryBuf, headerEnd);
    const contentData = body.slice(headerEnd + 4, nextBoundary - 2);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (filenameMatch) {
      files.push({
        fieldname: nameMatch ? nameMatch[1] : "file",
        filename: filenameMatch[1],
        data: contentData,
        headers,
      });
    }
    start = nextBoundary;
  }
  return files;
}

function getFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR)
    .filter(f => f.endsWith(".pdf"))
    .map(f => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return {
        name: f,
        size: stat.size,
        uploaded: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Serve index
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(INDEX));
  }

  // List files API
  if (pathname === "/api/files" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getFiles()));
  }

  // Delete file API
  if (pathname.startsWith("/api/delete/") && req.method === "DELETE") {
    const filename = decodeURIComponent(pathname.replace("/api/delete/", ""));
    const filepath = path.join(UPLOAD_DIR, path.basename(filename));
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ success: true }));
    }
    res.writeHead(404);
    return res.end("Not found");
  }

  // Serve uploaded PDF
  if (pathname.startsWith("/uploads/")) {
    const filename = decodeURIComponent(pathname.replace("/uploads/", ""));
    const filepath = path.join(UPLOAD_DIR, path.basename(filename));
    if (fs.existsSync(filepath)) {
      const ext = path.extname(filepath);
      res.writeHead(200, {
        "Content-Type": getMimeType(ext),
        "Content-Disposition": "inline",
      });
      return fs.createReadStream(filepath).pipe(res);
    }
    res.writeHead(404);
    return res.end("Not found");
  }

  // Upload file
  if (pathname === "/api/upload" && req.method === "POST") {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400);
      return res.end("Bad request");
    }
    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const files = parseMultipart(body, boundary);
      const saved = [];
      for (const file of files) {
        if (!file.filename.endsWith(".pdf")) continue;
        // Sanitize filename
        const safeName = file.filename.replace(/[^a-zA-Z0-9.\-_ ]/g, "_");
        const dest = path.join(UPLOAD_DIR, safeName);
        fs.writeFileSync(dest, file.data);
        saved.push(safeName);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, files: saved }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Study dashboard running on port", PORT));
