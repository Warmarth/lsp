// Load .env before the other modules read process.env
const path = require("node:path");
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (e) {
  if (e.code !== "ENOENT") console.error("Could not load .env:", e.message);
}

const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { createLspSession } = require("./lsp");

// Must be the same value as JWT_SECRET_KEY in the Flask backend.
const JWT_SECRET = process.env.JWT_SECRET_KEY;
if (!JWT_SECRET) {
  console.error("JWT_SECRET_KEY is not set in .env");
  process.exit(1);
}

// Returns the user id from a valid Flask access token, or null.
function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (payload.type && payload.type !== "access") return null;
    const id = String(payload.sub);
    // The id becomes a folder name, so allow only safe characters.
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;

const server = createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end("Hello World");
});

// ---- Limits (all overridable in .env) ----
const num = (key, fallback) => Number(process.env[key]) || fallback;
const MAX_SESSIONS = num("MAX_SESSIONS", 20); // all users together
const MAX_SESSIONS_PER_USER = num("MAX_SESSIONS_PER_USER", 4);
const MAX_MESSAGE_BYTES = num("MAX_MESSAGE_BYTES", 1_000_000);
const MAX_MESSAGES_PER_SEC = num("MAX_MESSAGES_PER_SEC", 100);
const IDLE_MS = num("IDLE_MINUTES", 30) * 60 * 1000;

// Each connection runs its own language server, so count them.
let totalSessions = 0;
const sessionsByUser = new Map();

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

// One WebSocket per language: ws://host:4000/?lang=python&token=...
// One or more origins, comma separated.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

wss.on("connection", (ws, req) => {
  // Without this, an oversized or malformed frame crashes the whole server.
  ws.on("error", (err) => console.warn("WebSocket error:", err.message));

  // Only accept connections from our own front end.
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    console.warn("Rejected connection from origin:", req.headers.origin);
    ws.close(1008, "Origin not allowed");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const userId = userFromToken(url.searchParams.get("token"));
  if (!userId) {
    console.warn("Rejected connection: missing or invalid token");
    ws.close(1008, "Unauthorized");
    return;
  }

  // Capacity checks (1013 = "try again later")
  const userCount = sessionsByUser.get(userId) || 0;
  if (totalSessions >= MAX_SESSIONS || userCount >= MAX_SESSIONS_PER_USER) {
    console.warn(
      `Rejected user ${userId}: at capacity (${totalSessions} total, ${userCount} for user)`,
    );
    ws.close(1013, "Server busy");
    return;
  }
  totalSessions++;
  sessionsByUser.set(userId, userCount + 1);

  const lang = url.searchParams.get("lang") || "go";
  const send = (payload) =>
    ws.readyState === 1 && ws.send(JSON.stringify(payload));

  let session = null;
  let idleTimer = null;

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(1000, "idle"), IDLE_MS);
  };

  // Registered before anything else can fail, so counts and processes are always released.
  ws.on("close", () => {
    clearTimeout(idleTimer);
    session?.dispose();
    totalSessions--;
    const left = (sessionsByUser.get(userId) || 1) - 1;
    if (left <= 0) sessionsByUser.delete(userId);
    else sessionsByUser.set(userId, left);
    console.log(
      `[${lang}] user ${userId} disconnected (${totalSessions} active)`,
    );
  });

  session = createLspSession(lang, ws, userId);
  if (!session) {
    send({ type: "error", message: `Unsupported language: ${lang}` });
    ws.close();
    return;
  }
  console.log(`[${lang}] user ${userId} connected (${totalSessions} active)`);
  resetIdle();

  // Message rate limit: count messages per one-second window.
  let windowStart = Date.now();
  let windowCount = 0;
  let limited = false;

  ws.on("message", (data) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > MAX_MESSAGES_PER_SEC) {
      if (!limited) {
        limited = true;
        console.warn(`User ${userId} sent too many messages`);
        ws.close(1008, "Too many messages");
      }
      return;
    }
    resetIdle();

    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "run") {
        send({
          type: "run-output",
          stream: "stderr",
          text: "Code execution is not available on this server.\n",
        });
        send({ type: "run-done", exitCode: 1 });
        return;
      }

      session.handle(msg);
    } catch (err) {
      console.error("Invalid message from browser:", err.message);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
