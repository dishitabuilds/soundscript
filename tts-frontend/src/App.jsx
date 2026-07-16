import { useState, useEffect } from "react";
import axios from "axios";
import Auth from "./Auth";
import { supabase } from "./supabase";
import History from "./History";
import Library from "./Library";
import DocumentView from "./DocumentView";

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState(null);

  const [text, setText] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return toast(
        "No active session. Reload the page and try again.",
        "error",
      );
    }

    setLoading(true);
    setAudioUrl("");

    try {
      // The backend derives the user id from this token. Sending a user_id in
      // the body would be meaningless now, and forgeable before.
      const res = await axios.post(
        `${import.meta.env.VITE_BACKEND_URL}/api/convert`,
        { text },
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );

      setAudioUrl(res.data.audioUrl);
      toast(
        res.data.cached
          ? "Loaded from cache — no API call needed!"
          : "Audio generated successfully!",
        "success",
      );
    } catch (err) {
      const serverMsg =
        err.response?.data?.error || err.message || "Error generating audio.";
      console.error("TTS Error:", err.response?.data || err);
      toast(serverMsg, "error");
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

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-black via-gray-900 to-blue-950 text-white">
        <p className="text-gray-400">Starting session…</p>
      </div>
    );
  }

  if (showAuth)
    return (
      <Auth
        isGuest={isGuest}
        onDone={() => setShowAuth(false)}
        onBack={() => setShowAuth(false)}
      />
    );

  if (openDocumentId)
    return (
      <DocumentView
        documentId={openDocumentId}
        onBack={() => setOpenDocumentId(null)}
      />
    );

  if (showLibrary)
    return (
      <Library
        onOpen={(id) => setOpenDocumentId(id)}
        onBack={() => setShowLibrary(false)}
      />
    );

  if (showHistory)
    return <History user={user} onBack={() => setShowHistory(false)} />;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-black via-gray-900 to-blue-950 text-white relative overflow-hidden">
      {/* Background glowing orbs */}
      <div className="absolute top-20 left-20 w-64 h-64 bg-blue-600/20 rounded-full blur-3xl"></div>
      <div className="absolute bottom-20 right-20 w-72 h-72 bg-purple-600/20 rounded-full blur-3xl"></div>

      {/* Premium Floating Navbar */}
      <nav className="w-full flex items-center justify-between px-10 py-5 backdrop-blur-xl bg-white/5 border-b border-white/10 sticky top-0 z-50">
        <h1 className="text-2xl font-semibold tracking-wide flex items-center gap-2">
          🔊 <span>SoundScript</span>
        </h1>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowLibrary(true)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 border border-white/10 transition"
          >
            Library
          </button>

          <button
            onClick={() => setShowHistory(true)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 border border-white/10 transition"
          >
            History
          </button>

          {isGuest ? (
            <button
              onClick={() => setShowAuth(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 transition"
            >
              Save my work
            </button>
          ) : (
            <>
              <span className="text-sm text-gray-300 hidden sm:inline">
                {user?.email}
              </span>
              <button
                onClick={handleLogout}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 border border-white/10 transition"
              >
                Sign out
              </button>
            </>
          )}
        </div>
      </nav>

      {/* Centered main content */}
      <div className="flex flex-col items-center w-full px-6 mt-16">
        <h2 className="text-4xl font-extrabold mb-3 text-center drop-shadow-lg">
          Transform Text Into
          <span className="text-blue-400"> Human-like Speech</span>
        </h2>

        <p className="text-gray-400 mb-8 text-center">
          Got a whole PDF?{" "}
          <button
            onClick={() => setShowLibrary(true)}
            className="text-blue-400 hover:text-blue-300 underline"
          >
            Turn it into an audiobook
          </button>{" "}
          instead.
        </p>

        <div className="w-full max-w-3xl bg-white/10 backdrop-blur-2xl p-10 rounded-3xl border border-white/10 shadow-2xl">
          <label className="text-lg font-medium">Enter your text</label>

          <textarea
            className="w-full h-56 p-4 rounded-xl mt-3 bg-white/5 border border-white/20 focus:border-blue-400 transition shadow-inner"
            placeholder="Type your prompt here..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          ></textarea>

          <p className="text-gray-300 mt-2 text-right">
            {text.length}/{MAX_CHARS}
          </p>

          <button
            onClick={handleConvert}
            disabled={loading}
            className="w-full py-4 mt-6 rounded-xl text-lg font-semibold
bg-gradient-to-r from-blue-600 to-purple-600
hover:from-blue-500 hover:to-purple-500
transition-all shadow-lg hover:shadow-blue-500/30
disabled:opacity-50"
          >
            {loading ? "Processing..." : "Convert to Speech"}
          </button>

          {/* Toasts */}
          {error && (
            <p className="mt-4 text-red-400 text-sm animate-fade-in">
              ❗ {error}
            </p>
          )}

          {success && (
            <p className="mt-4 text-green-400 text-sm animate-fade-in">
              ✅ {success}
            </p>
          )}

          {/* Audio section */}
          {audioUrl && (
            <div className="mt-10 bg-black/20 p-6 rounded-2xl border border-white/10 shadow-xl">
              <p className="font-semibold text-lg mb-3">Your Audio</p>

              <audio
                controls
                src={audioUrl}
                className="w-full rounded-lg mb-4"
              ></audio>

              <a
                href={audioUrl}
                download
                className="text-blue-400 hover:text-blue-300 underline"
              >
                Download Audio
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
