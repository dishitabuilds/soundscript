const { getAuthClient, getUserClient } = require("./supabase");

/**
 * Verify the caller's Supabase JWT and attach their identity to the request.
 *
 * The user id comes from the verified token and nowhere else. Trusting a
 * user_id in the request body -- as this API originally did -- lets any caller
 * act as any user by typing a different uuid.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (!token) {
    return res
      .status(401)
      .json({ error: "Missing auth token. Sign in and retry." });
  }

  try {
    const { data, error } = await getAuthClient().auth.getUser(token);
    if (error || !data?.user) {
      return res
        .status(401)
        .json({ error: "Invalid or expired session. Sign in again." });
    }

    req.user = data.user;
    req.accessToken = token;
    req.supabase = getUserClient(token);
    next();
  } catch (err) {
    console.error("Auth check failed:", err.message);
    res.status(500).json({ error: "Could not verify session." });
  }
}

module.exports = { requireAuth };
