import { useState, useEffect } from "react";
import Auth from "./Auth";
import { supabase } from "./supabase";
import History from "./History";
import Library from "./Library";
import DocumentView from "./DocumentView";
import Settings from "./Settings";
import { convertText } from "./api";
import { useTheme } from "./theme";
import ThemeToggle from "./ThemeToggle";
import Loading from "./Loading";

// Does the stored session still correspond to a real user? A network failure is
// not an answer -- only a rejection from the auth server is -- so a flaky
// connection never throws away a session that is actually fine.
async function sessionIsLive() {
  const { error } = await supabase.auth.getUser();
  return !error || error.name === "AuthRetryableFetchError";
}

// Supabase is the first thing this app talks to -- before a single pixel of the
// real UI, it asks for an anonymous session -- so any wobble on that one call is
// what a visitor experiences as a dead site. One attempt cannot tell a cold
// start from an outage, so try a few times with a growing gap before declaring
// anything broken.
async function signInGuestWithRetry(attempts = 3) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (!error) return { data };

    lastError = error;

    // Only a transport failure is worth repeating. A rejection from the auth
    // server -- anonymous sign-in switched off, say -- will be rejected just as
    // fast the second time, and retrying only delays telling the visitor
    // something they can act on.
    const retryable = error.name === "AuthRetryableFetchError" && !error.status;
    if (!retryable) break;

    await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
  }

  return { error: lastError };
}

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  // Separate from `error` below on purpose: `error` is a transient toast, and a
  // session that never started is a permanent state that has to survive until
  // someone retries it.
  const [sessionError, setSessionError] = useState("");
  const [bootAttempt, setBootAttempt] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [text, setText] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const { dark, toggle } = useTheme();

  const MAX_CHARS = 500;

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();

      // getSession() only reads localStorage -- it never asks Supabase whether
      // that identity still exists. A returning visitor whose user was since
      // deleted (guest cleanup, a wiped auth table) therefore boots "signed in"
      // holding a token for a user that is gone: the UI looks fine, the refresh
      // loop retries forever in the console, and every API call comes back 401.
      // One round trip on boot turns that dead end into a fresh guest session.
      if (data?.session?.user && !(await sessionIsLive())) {
        await supabase.auth.signOut({ scope: "local" });
        data.session = null;
      }

      if (data?.session?.user) {
        if (mounted) {
          setUser(data.session.user);
          setBooting(false);
        }
        return;
      }

      // Guests get a real anonymous identity rather than a fake "guest" string,
      // so RLS, history and quotas all work through one code path. They can
      // later attach an email to this same account and keep their history.
      const { data: anon, error: anonError } = await signInGuestWithRetry();

      if (!mounted) return;

      if (anonError) {
        // A failed *fetch* never reached Supabase, so the provider settings are
        // not the story: the request died in the network (offline, or the auth
        // endpoint refusing the CORS preflight). Blaming the anon-sign-in
        // toggle for that sends anyone debugging it to the wrong dashboard page.
        // In practice the usual cause is the free project having been paused
        // for inactivity -- which no amount of retrying fixes, because a paused
        // project is woken from the dashboard and nowhere else.
        const unreachable =
          anonError.name === "AuthRetryableFetchError" && !anonError.status;

        setSessionError(
          unreachable
            ? "SoundScript can't reach its database right now. This is usually temporary, so try again in a moment. If it keeps happening, the Supabase project has most likely been paused for inactivity and needs resuming from the dashboard."
            : `Could not start a session: ${anonError.message}. Is anonymous sign-in enabled in Supabase?`,
        );
      } else {
        setUser(anon.user);
      }
      setBooting(false);
    };

    init();

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (mounted) setUser(session?.user || null);
      },
    );

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [bootAttempt]);

  const isGuest = user?.is_anonymous === true;
  // Not simply `!isGuest`: when the session fails to start there is no user at
  // all, and the header would otherwise offer "Sign out" beside a blank email
  // -- claiming an account is signed in while nothing on the page works.
  const signedIn = Boolean(user) && !isGuest;

  const handleLogout = async () => {
    await supabase.auth.signOut();
    // Drop straight back to a fresh guest session instead of a logged-out
    // dead end where nothing on the page works.
    const { data: anon } = await supabase.auth.signInAnonymously();
    setUser(anon?.user || null);
    setShowHistory(false);
    toast("Signed out.", "success");
  };

  const handleConvert = async () => {
    if (!text.trim()) return toast("Please enter text.", "error");
    if (text.length > MAX_CHARS)
      return toast(`Max ${MAX_CHARS} characters allowed.`, "error");

    setLoading(true);
    setAudioUrl("");
    setWaking(false);

    // The API sleeps after 15 minutes idle on Render's free plan and takes the
    // better part of a minute to come back. A bare spinner makes that look like
    // a hang and people leave. Four seconds is long enough that a warm server
    // never shows this line, and short enough to explain a cold one before
    // anyone gives up on it.
    const wakingTimer = setTimeout(() => setWaking(true), 4000);

    try {
      const data = await convertText(text);
      setAudioUrl(data.audioUrl);
      toast(
        data.cached
          ? "Loaded from cache — no API call needed!"
          : "Audio generated successfully!",
        "success",
      );
    } catch (err) {
      toast(err.message || "Error generating audio.", "error");
    } finally {
      // finally, not a trailing statement: an early return or a throw from the
      // toast would otherwise leave the button disabled and the timer live.
      clearTimeout(wakingTimer);
      setWaking(false);
      setLoading(false);
    }
  };

  const toast = (msg, type) => {
    if (type === "error") setError(msg);
    if (type === "success") setSuccess(msg);

    setTimeout(() => {
      setError("");
      setSuccess("");
    }, 2500);
  };

  // Every view shares the toggle, so it is mounted once out here.
  const chrome = <ThemeToggle dark={dark} onToggle={toggle} />;

  if (booting) {
    return (
      <>
        {chrome}
        <Loading message="Starting session…" />
      </>
    );
  }

  // A session that never started is a dead end, not a cosmetic problem: every
  // control below needs a token. Rendering the normal page with a red line
  // under it invites people to keep clicking things that cannot work, so take
  // over the screen and offer the one action that might help.
  if (sessionError) {
    return (
      <>
        {chrome}
        <div className="min-h-screen flex flex-col items-center justify-center bg-page text-ink px-6 text-center">
          <h1 className="font-display text-2xl sm:text-3xl mb-3">
            🔊 SoundScript can’t connect
          </h1>

          <p className="text-soft max-w-md mb-8 leading-relaxed">
            {sessionError}
          </p>

          <button
            onClick={() => {
              setSessionError("");
              setBooting(true);
              setBootAttempt((n) => n + 1);
            }}
            className="px-6 py-3 rounded-xl font-semibold bg-gold hover:bg-gold-strong text-on-gold transition shadow-sm"
          >
            Try again
          </button>
        </div>
      </>
    );
  }

  // Nav destinations, shared between the desktop bar and the mobile drawer so
  // the two can never drift apart.
  const go = (fn) => () => {
    fn();
    setMenuOpen(false);
  };
  const navLinks = [
    { label: "Library", onClick: go(() => setShowLibrary(true)) },
    { label: "History", onClick: go(() => setShowHistory(true)) },
    { label: "Settings", onClick: go(() => setShowSettings(true)) },
  ];

  if (showAuth)
    return (
      <>
        {chrome}
        <Auth
          isGuest={isGuest}
          onDone={() => setShowAuth(false)}
          onBack={() => setShowAuth(false)}
        />
      </>
    );

  if (openDocumentId)
    return (
      <>
        {chrome}
        <DocumentView
          documentId={openDocumentId}
          onBack={() => setOpenDocumentId(null)}
        />
      </>
    );

  if (showLibrary)
    return (
      <>
        {chrome}
        <Library
          onOpen={(id) => setOpenDocumentId(id)}
          onBack={() => setShowLibrary(false)}
        />
      </>
    );

  if (showHistory)
    return (
      <>
        {chrome}
        <History user={user} onBack={() => setShowHistory(false)} />
      </>
    );

  if (showSettings)
    return (
      <>
        {chrome}
        <Settings onBack={() => setShowSettings(false)} />
      </>
    );

  return (
    <div className="min-h-screen flex flex-col bg-page text-ink transition-colors">
      {chrome}

      <nav className="w-full bg-surface border-b border-line sticky top-0 z-40">
        <div className="flex items-center justify-between px-5 sm:px-10 py-4">
          <h1 className="font-display text-xl sm:text-2xl tracking-wide flex items-center gap-2">
            🔊 <span>SoundScript</span>
          </h1>

          {/* Desktop: inline links. */}
          <div className="hidden sm:flex items-center gap-2">
            {navLinks.map((link) => (
              <button
                key={link.label}
                onClick={link.onClick}
                className="px-4 py-2 rounded-lg text-sm font-medium text-ink hover:bg-sunken border border-transparent hover:border-line transition"
              >
                {link.label}
              </button>
            ))}

            {isGuest && (
              <button
                onClick={() => setShowAuth(true)}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-gold hover:bg-gold-strong text-on-gold transition"
              >
                Save my work
              </button>
            )}

            {signedIn && (
              <>
                <span className="text-sm text-soft max-w-40 truncate">
                  {user?.email}
                </span>
                <button
                  onClick={handleLogout}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-ink hover:bg-sunken border border-line transition"
                >
                  Sign out
                </button>
              </>
            )}
          </div>

          {/* Mobile: a hamburger that opens the drawer below. */}
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            className="sm:hidden w-10 h-10 rounded-lg hover:bg-sunken border border-line flex items-center justify-center"
          >
            <svg
              viewBox="0 0 24 24"
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              {menuOpen ? (
                <path d="M6 6 L18 18 M18 6 L6 18" />
              ) : (
                <path d="M4 7 H20 M4 12 H20 M4 17 H20" />
              )}
            </svg>
          </button>
        </div>

        {/* Mobile drawer. */}
        {menuOpen && (
          <div className="sm:hidden px-5 pb-4 flex flex-col gap-1 border-t border-line">
            {navLinks.map((link) => (
              <button
                key={link.label}
                onClick={link.onClick}
                className="w-full text-left px-4 py-3 rounded-lg text-base font-medium text-ink hover:bg-sunken transition"
              >
                {link.label}
              </button>
            ))}

            {isGuest && (
              <button
                onClick={go(() => setShowAuth(true))}
                className="w-full px-4 py-3 rounded-lg text-base font-semibold bg-gold hover:bg-gold-strong text-on-gold transition mt-1"
              >
                Save my work
              </button>
            )}

            {signedIn && (
              <>
                <p className="px-4 pt-2 text-sm text-soft truncate">
                  {user?.email}
                </p>
                <button
                  onClick={go(handleLogout)}
                  className="w-full text-left px-4 py-3 rounded-lg text-base font-medium text-ink hover:bg-sunken transition"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        )}
      </nav>

      <div className="flex flex-col items-center w-full px-5 sm:px-6 mt-10 sm:mt-16">
        <h2 className="font-display text-3xl sm:text-4xl mb-3 text-center">
          Every document deserves
          <span className="text-gold"> a voice</span>
        </h2>

        <p className="text-soft mb-8 text-center">
          Got a whole document?{" "}
          <button
            onClick={() => setShowLibrary(true)}
            className="text-gold hover:text-gold-strong underline underline-offset-2"
          >
            Turn it into an audiobook
          </button>{" "}
          instead.
        </p>

        <div className="w-full max-w-3xl bg-surface p-6 sm:p-10 rounded-2xl border border-line shadow-sm">
          <label className="text-lg font-medium">Enter your text</label>

          <textarea
            className="w-full h-56 p-4 rounded-xl mt-3 bg-sunken border border-line focus:border-gold outline-none transition placeholder:text-soft"
            placeholder="Type or paste a short passage…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          ></textarea>

          <p className="text-soft mt-2 text-right text-sm tabular-nums">
            {text.length}/{MAX_CHARS}
          </p>

          <button
            onClick={handleConvert}
            disabled={loading}
            className="w-full py-4 mt-6 rounded-xl text-lg font-semibold bg-gold hover:bg-gold-strong text-on-gold transition shadow-sm disabled:opacity-50"
          >
            {loading ? "Narrating…" : "Convert to Speech"}
          </button>

          {loading && waking && (
            <p className="mt-4 text-soft text-sm">
              ⏳ Waking the server up — it sleeps when idle on the free plan, so
              this first one can take up to a minute.
            </p>
          )}

          {error && <p className="mt-4 text-danger text-sm">❗ {error}</p>}

          {success && <p className="mt-4 text-ok text-sm">✅ {success}</p>}

          {audioUrl && (
            <div className="mt-10 bg-sunken p-6 rounded-2xl border border-line">
              <p className="font-display text-lg mb-3">Your audio</p>

              <audio
                controls
                src={audioUrl}
                className="w-full rounded-lg mb-4"
              ></audio>

              <a
                href={audioUrl}
                download
                className="text-gold hover:text-gold-strong underline underline-offset-2 text-sm"
              >
                Download audio
              </a>
            </div>
          )}
        </div>
      </div>

      <footer className="mt-auto py-8 text-center text-sm text-soft">
        made with <span className="text-gold">♥</span> by dishita
      </footer>
    </div>
  );
}
