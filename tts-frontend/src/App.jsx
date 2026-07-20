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

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [text, setText] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const { dark, toggle } = useTheme();

  const MAX_CHARS = 500;

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();

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
      const { data: anon, error: anonError } =
        await supabase.auth.signInAnonymously();

      if (!mounted) return;

      if (anonError) {
        setError(
          `Could not start a session: ${anonError.message}. Is anonymous sign-in enabled in Supabase?`,
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
  }, []);

  const isGuest = user?.is_anonymous === true;

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
    }

    setLoading(false);
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

            {isGuest ? (
              <button
                onClick={() => setShowAuth(true)}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-gold hover:bg-gold-strong text-on-gold transition"
              >
                Save my work
              </button>
            ) : (
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

            {isGuest ? (
              <button
                onClick={go(() => setShowAuth(true))}
                className="w-full px-4 py-3 rounded-lg text-base font-semibold bg-gold hover:bg-gold-strong text-on-gold transition mt-1"
              >
                Save my work
              </button>
            ) : (
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
