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

// Service-role client: bypasses RLS entirely. Only two places may hold one --
// the standalone worker (drains every user's queue) and the public podcast
// feed (resolves a bare token with no user session). Handing it to a request
// path that also trusts caller input would undo the entire RLS design.
let serviceClient = null;
function getServiceClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  if (!serviceClient) {
    serviceClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return serviceClient;
}

module.exports = { getAuthClient, getUserClient, getServiceClient, requireEnv };
