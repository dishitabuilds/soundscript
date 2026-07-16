const { createClient } = require("@supabase/supabase-js");

function requireEnv() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables. Create a .env file.",
    );
  }
}

// Anon-key client, used only to verify tokens. It carries no user context, so
// every RLS-protected query it makes runs with auth.uid() = NULL and fails --
// which is exactly the bug this codebase used to have.
let authClient = null;
function getAuthClient() {
  requireEnv();
  if (!authClient) {
    authClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
  }
  return authClient;
}

// Per-request client carrying the caller's JWT, so auth.uid() resolves to them
// and the RLS policies apply as written.
function getUserClient(accessToken) {
  requireEnv();
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = { getAuthClient, getUserClient, requireEnv };
