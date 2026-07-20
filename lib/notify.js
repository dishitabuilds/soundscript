// "Your audiobook is ready" email, sent when a job finishes in the standalone
// worker.
//
// Only the worker sends these, deliberately: inline processing means the user
// kicked the job off seconds ago and is watching the SSE progress bar, but a
// worker-processed job finishes minutes later with the tab long closed --
// that is the moment an email is worth something.
//
// Resend is the transport because it is one POST with an API key. No key, no
// emails, no error: the feature simply stays off.

const axios = require("axios");

const FROM =
  process.env.NOTIFY_FROM_EMAIL || "SoundScript <onboarding@resend.dev>";

function notificationsEnabled() {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} service service-role client
 * @param {{ userId: string, title: string, status: string, error?: string }} info
 */
async function notifyJobFinished(service, { userId, title, status, error }) {
  if (!notificationsEnabled()) return;

  // Guests have no address to write to; the lookup needs the admin API, which
  // is why this lives behind the service client only.
  const { data, error: lookupErr } =
    await service.auth.admin.getUserById(userId);
  const email = data?.user?.email;
  if (lookupErr || !email || data.user.is_anonymous) return;

  const ok = status === "succeeded";
  const subject = ok
    ? `"${title}" is ready to listen to`
    : `"${title}" could not be narrated`;
  const body = ok
    ? `Your audiobook for "${title}" has finished. Open SoundScript to listen or download it.`
    : `Narrating "${title}" failed: ${error || "unknown error"}. You can retry it from the document page.`;

  try {
    await axios.post(
      "https://api.resend.com/emails",
      { from: FROM, to: [email], subject, text: body },
      {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        timeout: 10000,
      },
    );
  } catch (err) {
    // A failed email must never fail the job that triggered it.
    console.error(`notify: email to ${email} failed: ${err.message}`);
  }
}

module.exports = { notifyJobFinished, notificationsEnabled };
