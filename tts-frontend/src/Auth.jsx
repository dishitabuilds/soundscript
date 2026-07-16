import { useState } from "react";
import { supabase } from "./supabase";

export default function Auth({ isGuest, onDone, onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Attaching credentials to the existing anonymous user keeps the same uid, so
  // everything already in their history stays theirs. Calling signUp() instead
  // would mint a new uid and silently orphan all of it.
  const handleUpgrade = async () => {
    setError("");
    setNotice("");
    setBusy(true);

    const { error: updateError } = await supabase.auth.updateUser({
      email,
      password,
    });

    setBusy(false);

    if (updateError) return setError(updateError.message);

    setNotice(
      "Check your inbox to confirm your email. Your history is already saved to this account.",
    );
  };

  const handleLogin = async () => {
    setError("");
    setNotice("");
    setBusy(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setBusy(false);

    if (signInError) return setError(signInError.message);
    onDone();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-black via-gray-900 to-blue-950 text-white px-6">
      <div className="bg-white/10 backdrop-blur-2xl p-8 rounded-2xl w-full max-w-md border border-white/10 shadow-2xl">
        <h2 className="text-2xl font-bold mb-2 text-center">
          {isGuest ? "Save your work" : "Sign in"}
        </h2>

        <p className="text-sm text-gray-300 mb-6 text-center">
          {isGuest
            ? "Add an email and password to keep your conversions across devices."
            : "Sign in to your account."}
        </p>

        <input
          type="email"
          placeholder="Email"
          value={email}
          className="w-full p-3 rounded-lg mb-3 bg-white/5 border border-white/20 focus:border-blue-400 outline-none transition"
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          className="w-full p-3 rounded-lg mb-3 bg-white/5 border border-white/20 focus:border-blue-400 outline-none transition"
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="text-red-400 text-sm mb-3">❗ {error}</p>}
        {notice && <p className="text-green-400 text-sm mb-3">✅ {notice}</p>}

        <button
          disabled={busy || !email || !password}
          className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 py-3 rounded-lg mb-3 font-semibold transition disabled:opacity-50"
          onClick={isGuest ? handleUpgrade : handleLogin}
        >
          {busy ? "Working…" : isGuest ? "Create account" : "Sign in"}
        </button>

        {isGuest && (
          <button
            disabled={busy || !email || !password}
            className="w-full bg-white/10 hover:bg-white/20 border border-white/10 py-3 rounded-lg mb-3 text-sm transition disabled:opacity-50"
            onClick={handleLogin}
          >
            I already have an account
          </button>
        )}

        <button
          className="w-full text-gray-400 hover:text-white py-2 text-sm transition"
          onClick={onBack}
        >
          ← Back
        </button>

        {isGuest && (
          <p className="text-xs text-gray-500 mt-4 text-center">
            Signing into an existing account will leave this guest session's
            history behind.
          </p>
        )}
      </div>
    </div>
  );
}
