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
app.use((req, res, next) => {
  if (
    req.is("application/json") &&
    (!req.body || Array.isArray(req.body) || typeof req.body !== "object")
  ) {
    return res.status(400).json({ error: "JSON body must be an object." });
  }
  next();
});

app.get("/", (req, res) => {
  res.send("SoundScript Backend is running!");
});

app.get("/api/health", async (req, res) => {
  const body = {
    ok: true,
    revision: process.env.RENDER_GIT_COMMIT || null,
    // Reported so a deploy can be checked without reading logs: a missing key
    // here explains every 500 from /api/convert at a glance.
    elevenlabs: Boolean(process.env.ELEVEN_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    kokoro: Boolean(process.env.KOKORO_URL),
    ttsProvider: require("./lib/tts").DEFAULT_PROVIDER,
    ragEnabled: process.env.RAG_ENABLED === "true",
    ragModel: Boolean(process.env.RAG_MODEL_URL),
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
  };

  // ?debug=1 exercises the real auth path once and reports whether the client
  // could reach Supabase. Gated so Render's frequent health pings stay cheap.
  // authOk=false means the auth server never answered -- the error string
  // (never a secret) says why. Safe to leave in: it reveals no keys.
  if (req.query.debug === "1") {
    try {
      const { getAuthClient } = require("./lib/supabase");
      const { error } = await getAuthClient().auth.getUser(
        "health.diagnostic.token",
      );

      // supabase-js returns network failures instead of throwing, so a `try`
      // that merely completes proves nothing: an unreachable project used to
      // report authOk:true while every browser login failed -- the one
      // diagnostic meant to catch that outage was the one lying about it.
      // Only a reply from the auth server counts: an "invalid token" 401 is a
      // reply and means configured; AuthRetryableFetchError with status 0
      // means the request never got one.
      const noAnswer =
        error && error.name === "AuthRetryableFetchError" && !error.status;

      body.authOk = !noAnswer;
      if (noAnswer) body.authError = `Supabase unreachable: ${error.message}`;
    } catch (err) {
      body.authOk = false;
      body.authError = err.message;
    }
  }

  res.json(body);
});

// Keeps both free plans awake. Render spins a free service down after 15
// minutes idle, and Supabase pauses a free project after roughly a week with no
// database requests -- and a paused project cannot be woken by traffic, only by
// a click in the dashboard. That pause is what takes this site down hardest:
// the browser asks Supabase for an anonymous session before it renders
// anything, so a sleeping database shows up as "Cannot reach the SoundScript
// service" on a page that is otherwise fine.
//
// One request here covers both halves. Reaching this process wakes Render, and
// the select below is a real PostgREST round trip to Postgres, which is the
// activity Supabase counts. RLS hands an anon caller zero rows and that is the
// point -- the query still ran, and no data leaves.
//
// Deliberately unauthenticated: the caller is a cron job with no session, and
// the reply carries a boolean and a duration, nothing else.
app.get("/api/keepalive", async (req, res) => {
  const startedAt = Date.now();

  try {
    const { getAuthClient } = require("./lib/supabase");
    const { error } = await getAuthClient()
      .from("documents")
      .select("id")
      .limit(1);

    // 503 rather than 200-with-a-flag: the cron treats a non-200 as the alert,
    // and a paused project is exactly the thing worth being loud about.
    if (error) {
      console.error("Keepalive: database did not answer:", error.message);
      return res.status(503).json({
        ok: false,
        db: false,
        error: error.message,
        code: error.code || null,
        ms: Date.now() - startedAt,
      });
    }

    res.json({ ok: true, db: true, ms: Date.now() - startedAt });
  } catch (err) {
    // Missing env vars throw out of requireEnv() rather than returning an
    // error, so a misconfigured deploy lands here instead of above.
    console.error("Keepalive failed:", err.message);
    res.status(503).json({
      ok: false,
      db: false,
      error: err.message,
      ms: Date.now() - startedAt,
    });
  }
});

app.use("/api/convert", convertRoutes.router);
app.use("/api/documents/:id/rag", require("./routes/rag").router);
app.use("/api/documents", documentRoutes.router);
app.use("/api/voices", voiceRoutes.router);
app.use("/api/pronunciations", pronunciationRoutes.router);
app.use("/api/feed", feedRoutes.router);
// Public: podcast apps authenticate with the token in the URL, not a JWT.
app.use("/feeds", feedRoutes.publicRouter);

// Multer signals "file too large" by throwing, and without this the client gets
// an opaque 500 instead of being told which limit it hit.
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body." });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
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

module.exports = app;
