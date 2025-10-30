var http = require("http");
var fs = require("fs");
var ws = require("ws");
var path = require("path");
var URL = require("url");

// === Config ===
const MAX_DATAURL_SIZE = 1 * 1024 * 1024; // 1 MB max for data URL

// === Helper Functions ===
function setNoCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
}
function runStaticStuff(req, res, forceStatus) {
  var url = URL.parse(req.url);
  var pathname = url.pathname;
  setNoCorsHeaders(res);
  var file = path.join("./static/", pathname);
  if (pathname == "/") file = "static/index.html";
  if (file.split(".").length < 2) file += ".html";
  if (!fs.existsSync(file)) {
    file = "errors/404.html";
    res.statusCode = 404;
  }
  if (typeof forceStatus !== "undefined") {
    file = "errors/" + forceStatus + ".html";
    res.statusCode = forceStatus;
  }
  fs.createReadStream(file).pipe(res);
}
function createRandomCharsString(length) {
  var keys = "ABCDEFGHIJKLKMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890";
  var key = "";
  while (key.length < length) {
    key += keys[Math.floor(Math.random() * keys.length)];
  }
  return key;
}

// === Main Server ===
const server = http.createServer(async function (req, res) {
  var url = decodeURIComponent(req.url);
  var urlsplit = url.split("/");
  setNoCorsHeaders(res);
  
  if (urlsplit[1] == "room" && urlsplit[2] == "create") {
    const newRoomId =  Date.now().toString();
    createRoom(newRoomId); // create the room early
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ roomId: newRoomId }));
    return;
  }

  runStaticStuff(req, res);
});

// === Room Management ===
var rooms = {}; // { roomId: { wsServer, timeout, createdAt, dataURL } }

function createRoom(roomId) {
  if (rooms[roomId]) return rooms[roomId].wsServer;

  const wsServer = new ws.WebSocketServer({ noServer: true });
  let dataURL = "";
  let idCounter = 0;

  const room = {
    wsServer,
    timeout: null,
    createdAt: Date.now(),
    dataURL
  };

  function startCleanupTimeout() {
    room.timeout = setTimeout(() => {
      if (wsServer.clients.size === 0) {
        wsServer.close();
        delete rooms[roomId];
        console.log(`[ROOM ${roomId}] Cleaned up`);
      }
    }, 5 * 60 * 1000); // 5 mins
  }

  wsServer.on("connection", function (socket) {
    clearTimeout(room.timeout); // Cancel disposal timer
    idCounter++;
    socket._sid = idCounter;
    socket._isAlive = true;

    socket.send(JSON.stringify({ type: "canvasURL", url: room.dataURL }));

    // Ghost WebSocket detection
    const pingTimeout = setTimeout(() => {
      if (!socket._hasResponded) {
        console.log(`[ROOM ${roomId}] Ghost WebSocket disconnected`);
        socket.terminate();
      }
    }, 15 * 1000); // Must respond in 15s

    socket.on("message", function (msg) {
      socket._hasResponded = true;
      try {
        const json = JSON.parse(msg.toString());

        if (json.type === "canvasURL") {
          if (typeof json.url === "string" && json.url.length <= MAX_DATAURL_SIZE) {
            room.dataURL = json.url;
          } else {
            console.warn(`[ROOM ${roomId}] DataURL too large or invalid. Ignored.`);
          }
        } else if (json.type === "actionHistory") {
          if (Array.isArray(json.cursor)) {
            socket._cursorX = +json.cursor[0] || 0;
            socket._cursorY = +json.cursor[1] || 0;
            socket._cursorName = String(json.cursor[2]);
          }
          wsServer.clients.forEach((ws) => {
            if (ws !== socket) {
              ws.send(JSON.stringify({
                type: "applyActionHistory",
                history: json.history
              }));
            }
          });
        }
      } catch (e) {
        console.log("WebSocket message error:", e);
      }
    });

    var cursorInterval = setInterval(() => {
      var positions = [];
      Array.from(wsServer.clients).filter((sock) => sock._sid !== socket._sid).forEach((sock) => {
        if (sock._cursorName) {
          positions.push([sock._cursorX,sock._cursorY,sock._cursorName]);
        }
      });
      socket.send(JSON.stringify({
        type: "cursors",
        positions
      }));
    },1000/30);

    socket.on("close", function () {
      clearInterval(cursorInterval);
      idCounter--;
      if (wsServer.clients.size === 0) {
        startCleanupTimeout();
      }
    });
  });

  // Ask one client for updates regularly
  wsServer._serverInterval = setInterval(() => {
    const [first] = wsServer.clients;
    if (first) {
      try {
        first.send(JSON.stringify({ type: "updateCanvasURL" }));
      } catch (e) {}
    }
  }, 100); // 10 FPS

  rooms[roomId] = room;
  return wsServer;
}

// === WebSocket Upgrade Routing ===
server.on("upgrade", function upgrade(request, socket, head) {
  var url = decodeURIComponent(request.url);
  var urlsplit = url.split("/");
  var roomId = urlsplit[1];

  if (!rooms[roomId]) {
    createRoom(roomId);
  }

  const wsServer = rooms[roomId].wsServer;
  wsServer.handleUpgrade(request, socket, head, function done(ws) {
    wsServer.emit("connection", ws, request);
  });
});

server.listen(8080, () => {
  console.log("Server listening on http://localhost:8080");
});
