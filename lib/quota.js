const DAILY_CHAR_QUOTA = Number(process.env.DAILY_CHAR_QUOTA || 10000);
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Characters this user has actually sent to ElevenLabs in the last 24 hours.
 *
 * Counts both paths into the API:
 *   - tts_conversions, one row per single-shot synthesis (cache hits return
 *     before inserting, so every row here cost a call)
 *   - chunks with from_cache = false, one row per document chunk that was
 *     synthesised rather than reused
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase user-scoped client
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function charsUsedToday(supabase, userId) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const [conversions, chunks] = await Promise.all([
    supabase
      .from("tts_conversions")
      .select("input_text")
      .eq("user_id", userId)
      .gte("created_at", since),
    supabase
      .from("chunks")
      .select("char_count")
      .eq("user_id", userId)
      .eq("from_cache", false)
      .gte("created_at", since),
  ]);

  if (conversions.error)
    throw new Error(`Quota lookup failed: ${conversions.error.message}`);
  if (chunks.error)
    throw new Error(`Quota lookup failed: ${chunks.error.message}`);

  const fromConversions = (conversions.data || []).reduce(
    (sum, row) => sum + (row.input_text?.length || 0),
    0,
  );
  const fromChunks = (chunks.data || []).reduce(
    (sum, row) => sum + (row.char_count || 0),
    0,
  );

  return fromConversions + fromChunks;
}

/**
 * @returns {Promise<{ ok: boolean, used: number, remaining: number, quota: number }>}
 */
async function checkQuota(supabase, userId, wantChars) {
  const used = await charsUsedToday(supabase, userId);
  const remaining = Math.max(0, DAILY_CHAR_QUOTA - used);
  return {
    ok: used + wantChars <= DAILY_CHAR_QUOTA,
    used,
    remaining,
    quota: DAILY_CHAR_QUOTA,
  };
}

module.exports = { charsUsedToday, checkQuota, DAILY_CHAR_QUOTA };
