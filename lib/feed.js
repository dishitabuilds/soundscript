// Private podcast feed: a user's finished audiobooks as an RSS feed their
// podcast app can subscribe to.
//
// Podcast apps cannot send an Authorization header, so the feed URL itself
// carries a bearer token (see user_feeds). Enclosure URLs are signed storage
// URLs with a long expiry -- podcast apps cache the feed and fetch episodes
// hours later, so a five-minute URL would 403 by listening time.

const crypto = require("crypto");

// Long enough for a weekly-refresh podcast app to still fetch yesterday's
// enclosure; short enough that a leaked feed page goes dead in days.
const ENCLOSURE_TTL_S = Number(
  process.env.FEED_ENCLOSURE_TTL_S || 3 * 24 * 3600,
);

function newFeedToken() {
  return crypto.randomBytes(24).toString("base64url");
}

const escapeXml = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Fetch a user's finished documents and render them as RSS.
 *
 * Uses the service-role client because the caller authenticated with a feed
 * token, not a JWT -- there is no user session to scope a client to. Every
 * query here therefore filters by user_id explicitly; forgetting one would
 * leak another user's library into the feed.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} service service-role client
 * @param {string} userId owner of the feed
 * @param {{ title?: string }} [options]
 * @returns {Promise<string>} RSS XML
 */
async function buildFeedXml(service, userId, options = {}) {
  const { data: assets, error } = await service
    .from("audio_assets")
    .select("document_id, path, duration_seconds, byte_size, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Could not list assets: ${error.message}`);

  const docIds = (assets || []).map((a) => a.document_id);
  const titles = new Map();
  if (docIds.length) {
    const { data: docs } = await service
      .from("documents")
      .select("id, title")
      .eq("user_id", userId)
      .in("id", docIds);
    for (const d of docs || []) titles.set(d.id, d.title);
  }

  const items = [];
  for (const asset of assets || []) {
    const { data: signed, error: signErr } = await service.storage
      .from("library")
      .createSignedUrl(asset.path, ENCLOSURE_TTL_S);
    if (signErr || !signed?.signedUrl) continue; // skip, don't kill the feed

    const title = titles.get(asset.document_id) || "Untitled";
    const seconds = Math.round(Number(asset.duration_seconds) || 0);

    items.push(
      [
        "    <item>",
        `      <title>${escapeXml(title)}</title>`,
        // The document id is the stable identity of an episode; the signed URL
        // changes every fetch and would make apps re-download everything.
        `      <guid isPermaLink="false">soundscript-${asset.document_id}</guid>`,
        `      <pubDate>${new Date(asset.created_at).toUTCString()}</pubDate>`,
        `      <enclosure url="${escapeXml(signed.signedUrl)}" length="${asset.byte_size || 0}" type="audio/mpeg"/>`,
        `      <itunes:duration>${seconds}</itunes:duration>`,
        "    </item>",
      ].join("\n"),
    );
  }

  const feedTitle = options.title || "SoundScript library";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">`,
    "  <channel>",
    `    <title>${escapeXml(feedTitle)}</title>`,
    `    <description>Documents narrated by SoundScript.</description>`,
    `    <language>en</language>`,
    items.join("\n"),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

module.exports = { buildFeedXml, newFeedToken, escapeXml, ENCLOSURE_TTL_S };
