const { createClient } = require("@supabase/supabase-js");

// Env values pasted into a dashboard field commonly arrive mangled: a missing
// scheme, or -- worse and invisible -- an embedded newline where a long key
// wrapped. A key with a newline is an invalid HTTP header value, so
// getUser() throws and every request 500s. Neither a URL nor a JWT/API key ever
// contains legitimate whitespace, so stripping all of it is both safe and the
// difference between a deploy that works and one that rejects every login.
function stripWhitespace(v) {
  return (v || "").replace(/\s+/g, "");
}

function supabaseUrl() {
  const raw = stripWhitespace(process.env.SUPABASE_URL);
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function anonKey() {
  return stripWhitespace(process.env.SUPABASE_ANON_KEY);
}

function serviceKey() {
  return stripWhitespace(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function requireEnv() {
  if (!supabaseUrl() || !anonKey()) {
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
    authClient = createClient(supabaseUrl(), anonKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return authClient;
}

// Per-request client carrying the caller's JWT, so auth.uid() resolves to them
// and the RLS policies apply as written.
function getUserClient(accessToken) {
  requireEnv();
  return createClient(supabaseUrl(), anonKey(), {
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
  if (!supabaseUrl() || !serviceKey()) {
    return null;
  }
  if (!serviceClient) {
    serviceClient = createClient(supabaseUrl(), serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceClient;
}

module.exports = {
  getAuthClient,
  getUserClient,
  getServiceClient,
  requireEnv,
  supabaseUrl,
};
