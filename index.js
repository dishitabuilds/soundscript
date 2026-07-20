// server/index.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const convertRoutes = require("./routes/convert");
const documentRoutes = require("./routes/documents");
const voiceRoutes = require("./routes/voices");
const pronunciationRoutes = require("./routes/pronunciations");
const feedRoutes = require("./routes/feed");
const { ocrAvailable } = require("./lib/extract/ocr");
const { supabaseUrl } = require("./lib/supabase");

const app = express();

// Behind Vercel/proxies, express-rate-limit needs the real client IP.
app.set("trust proxy", 1);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// ALLOWED_ORIGINS=* means allow any origin. Safe here because auth is a Bearer
// JWT rather than a cookie -- a hostile origin still cannot forge a session,
// and RLS guards every row regardless of who asks.
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.includes("*");

app.use(
  cors({
    origin(origin, callback) {
      // Non-browser callers (curl, health checks) send no Origin.
      if (!origin) return callback(null, true);
      if (ALLOW_ALL_ORIGINS || ALLOWED_ORIGINS.includes(origin))
        return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
  }),
);

// Applies to JSON bodies only; PDF uploads are multipart and capped separately
// by multer in routes/documents.js.
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.send("SoundScript Backend is running!");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    // Reported so a deploy can be checked without reading logs: a missing key
    // here explains every 500 from /api/convert at a glance.
    elevenlabs: Boolean(process.env.ELEVEN_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    supabase: Boolean(
      process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY,
    ),
    // The configured Supabase host, so a misconfigured URL is visible without
    // reading logs. Not a secret -- the project ref ships in the browser
    // bundle. null means the URL is malformed (the usual cause of auth 500s).
    supabaseHost: (() => {
      try {
        return new URL(supabaseUrl()).host;
      } catch {
        return null;
      }
    })(),
    ocr: ocrAvailable(),
    // false means jobs wait for the standalone worker (worker.js).
    inlineProcessing: process.env.INLINE_PROCESSING !== "false",
    feeds: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
});

app.use("/api/convert", convertRoutes.router);
app.use("/api/documents", documentRoutes.router);
app.use("/api/voices", voiceRoutes.router);
app.use("/api/pronunciations", pronunciationRoutes.router);
app.use("/api/feed", feedRoutes.router);
// Public: podcast apps authenticate with the token in the URL, not a JWT.
app.use("/feeds", feedRoutes.publicRouter);

// Multer signals "file too large" by throwing, and without this the client gets
// an opaque 500 instead of being told which limit it hit.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "That file is too large." });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err && /Unsupported file type/.test(err.message)) {
    return res.status(415).json({ error: err.message });
  }
  if (err && /not allowed by CORS/.test(err.message)) {
    return res.status(403).json({ error: err.message });
  }
  if (err) {
    console.error("Unhandled route error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
  next();
});

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Failing to bind is fatal: without this the catch-all below swallows it and
// the process exits 0, so a supervisor sees a healthy start that serves nothing.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other process first.`,
    );
  } else {
    console.error("Server failed to start:", err);
  }
  process.exit(1);
});

module.exports = app;

// A rejected promise usually means one request failed, and Express has already
// answered it, so log and stay up.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// An uncaught exception leaves the process in an unknown state, so serving on is
// worse than dying: exit and let the supervisor restart from a clean slate.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, shutting down:", err);
  process.exit(1);
});
