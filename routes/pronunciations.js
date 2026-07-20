const express = require("express");

const { requireAuth } = require("../lib/auth");

const router = express.Router();

// Bounds mirror the CHECK constraints in the migration, so a too-long pattern
// fails here with a readable message instead of a constraint violation.
const MAX_PATTERN = 100;
const MAX_REPLACEMENT = 200;

/** GET /api/pronunciations — this user's rules, oldest first. */
router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from("pronunciation_rules")
    .select("id, pattern, replacement, created_at")
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rules: data });
});

/**
 * POST /api/pronunciations { pattern, replacement }
 *
 * Upsert by pattern: re-saving "TTS" replaces the old rule for "TTS" rather
 * than stacking a second one, because two rules for one pattern cannot both
 * apply.
 */
router.post("/", requireAuth, async (req, res) => {
  const pattern =
    typeof req.body.pattern === "string" ? req.body.pattern.trim() : "";
  const replacement =
    typeof req.body.replacement === "string" ? req.body.replacement.trim() : "";

  if (!pattern)
    return res.status(400).json({ error: "A pattern is required." });
  if (pattern.length > MAX_PATTERN) {
    return res
      .status(400)
      .json({ error: `Patterns are limited to ${MAX_PATTERN} characters.` });
  }
  if (replacement.length > MAX_REPLACEMENT) {
    return res.status(400).json({
      error: `Replacements are limited to ${MAX_REPLACEMENT} characters.`,
    });
  }

  const { data, error } = await req.supabase
    .from("pronunciation_rules")
    .upsert(
      { user_id: req.user.id, pattern, replacement },
      { onConflict: "user_id,pattern" },
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ rule: data });
});

/** DELETE /api/pronunciations/:id */
router.delete("/:id", requireAuth, async (req, res) => {
  const { error } = await req.supabase
    .from("pronunciation_rules")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = { router };
