const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  } else {
    res.writeHead(200);
    res.end("ok");
  }
});

const wss = new WebSocketServer({ server });

const rooms = {};

function getRoomCode(url) {
  const parts = (url || "").replace(/^\//, "").split("?")[0];
  return parts || "default";
}

function broadcast(room, data) {
  const msg = JSON.stringify(data);
  for (const client of room.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function getRoomState(room) {
  return {
    type: "state",
    playerCount: room.clients.size,
    locked: room.locked,
    buzzedBy: room.buzzedBy,
  };
}

wss.on("connection", (ws, req) => {
  const code = getRoomCode(req.url);

  if (!rooms[code]) {
    rooms[code] = { clients: new Set(), buzzedBy: null, locked: false };
  }

  const room = rooms[code];

  const playerNum = room.nextPlayer = (room.nextPlayer || 0) + 1;
  ws.playerName = "Player " + playerNum;

  room.clients.add(ws);

  ws.send(JSON.stringify({ type: "welcome", name: ws.playerName }));
  broadcast(room, getRoomState(room));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "buzz" && !room.locked) {
      room.locked = true;
      room.buzzedBy = ws.playerName;
      const buzzmsg_yes = JSON.stringify({ type: "buzzed", by: ws.playerName, isYou: true });
      const buzzmsg_no  = JSON.stringify({ type: "buzzed", by: ws.playerName, isYou: false });
      for (const client of room.clients) {
        if (client.readyState === 1) {
          client.send(client === ws ? buzzmsg_yes : buzzmsg_no);
        }
      }
    }

    if (msg.type === "reset") {
      room.locked = false;
      room.buzzedBy = null;
      broadcast(room, { type: "reset" });
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    broadcast(room, getRoomState(room));
    if (room.clients.size === 0) delete rooms[code];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Buzzer server on port", PORT));
