const express = require("express");
const rateLimit = require("express-rate-limit");

const { requireAuth } = require("../lib/auth");
const { getServiceClient } = require("../lib/supabase");
const { buildFeedXml, newFeedToken } = require("../lib/feed");

// Authenticated management of the caller's own feed.
const router = express.Router();

// The public, token-authenticated feed itself. Mounted separately at /feeds.
const publicRouter = express.Router();

function feedUrl(req, token) {
  // trust proxy is set in index.js, so protocol survives the Render proxy.
  return `${req.protocol}://${req.get("host")}/feeds/${token}.xml`;
}

/**
 * GET /api/feed — the caller's feed URL, creating the token on first ask.
 *
 * Created lazily rather than at signup: a feed token is a standing credential,
 * and most users will never use the feature. No token, nothing to leak.
 */
router.get("/", requireAuth, async (req, res) => {
  const { data: existing, error } = await req.supabase
    .from("user_feeds")
    .select("token")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  let token = existing?.token;
  if (!token) {
    token = newFeedToken();
    const { error: insErr } = await req.supabase
      .from("user_feeds")
      .insert({ user_id: req.user.id, token });
    if (insErr) return res.status(500).json({ error: insErr.message });
  }

  res.json({
    url: feedUrl(req, token),
    enabled: Boolean(getServiceClient()),
  });
});

/**
 * POST /api/feed/rotate — invalidate the old URL, issue a new one.
 * This is the whole revocation story for a leaked feed link.
 */
router.post("/rotate", requireAuth, async (req, res) => {
  const token = newFeedToken();

  const { error } = await req.supabase
    .from("user_feeds")
    .upsert({ user_id: req.user.id, token });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: feedUrl(req, token) });
});

// Feed fetches are automated and repetitive; cap them per IP before doing any
// storage signing work.
const feedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

/**
 * GET /feeds/:token.xml — the podcast feed. No JWT: the token IS the auth,
 * because podcast apps can only fetch plain URLs.
 */
publicRouter.get("/:token.xml", feedLimiter, async (req, res) => {
  const service = getServiceClient();
  if (!service) {
    // Deliberately vague to the outside; the log has the real reason.
    console.error("Feed requested but SUPABASE_SERVICE_ROLE_KEY is not set.");
    return res.status(404).send("Not found");
  }

  const { data: feed } = await service
    .from("user_feeds")
    .select("user_id")
    .eq("token", req.params.token)
    .maybeSingle();

  // Unknown token gets the same 404 as a disabled feature: probing for valid
  // tokens should learn nothing.
  if (!feed) return res.status(404).send("Not found");

  try {
    const xml = await buildFeedXml(service, feed.user_id);
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(xml);
  } catch (err) {
    console.error("Feed build failed:", err);
    res.status(500).send("Feed unavailable");
  }
});

module.exports = { router, publicRouter };
