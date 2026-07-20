import { useState, useEffect } from "react";
import {
  listPronunciations,
  savePronunciation,
  deletePronunciation,
  getFeed,
  rotateFeed,
} from "./api";

export default function Settings({ onBack }) {
  const [rules, setRules] = useState([]);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [saving, setSaving] = useState(false);

  const [feed, setFeed] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [error, setError] = useState("");

  useEffect(() => {
    listPronunciations()
      .then(setRules)
      .catch((err) => setError(err.message));
    // Asking for the feed URL creates the token on first visit -- it is a
    // standing credential, minted only for users who open this page.
    getFeed()
      .then(setFeed)
      .catch(() => {});
  }, []);

  const addRule = async (e) => {
    e.preventDefault();
    if (!pattern.trim()) return;
    setSaving(true);
    setError("");
    try {
      const rule = await savePronunciation(pattern.trim(), replacement.trim());
      // Upsert semantics: replace the row if the pattern already had a rule.
      setRules((rs) => [...rs.filter((r) => r.pattern !== rule.pattern), rule]);
      setPattern("");
      setReplacement("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (id) => {
    try {
      await deletePronunciation(id);
      setRules((rs) => rs.filter((r) => r.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const copyFeed = async () => {
    try {
      await navigator.clipboard.writeText(feed.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the URL is visible to copy by hand.
    }
  };

  const handleRotate = async () => {
    if (
      !confirm(
        "Rotate the feed URL? Podcast apps using the old link will stop updating.",
      )
    )
      return;
    setRotating(true);
    try {
      setFeed(await rotateFeed());
    } catch (err) {
      setError(err.message);
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="min-h-screen bg-page text-ink transition-colors px-5 sm:px-6 py-8 sm:py-10">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={onBack}
          className="mb-6 px-4 py-2 rounded-lg bg-surface hover:bg-sunken border border-line text-sm transition"
        >
          ← Back
        </button>

        <h1 className="font-display text-3xl mb-8">Settings</h1>

        {error && (
          <p className="mb-6 text-danger text-sm bg-danger/10 border border-danger/30 rounded-lg p-3">
            ❗ {error}
          </p>
        )}

        <section className="bg-surface border border-line rounded-2xl p-6 mb-6 shadow-sm">
          <h2 className="font-display text-xl mb-1">Pronunciation rules</h2>
          <p className="text-sm text-soft mb-5">
            Fix how the narrator says acronyms and names. Applied to every
            document you upload from now on — “RLS” → “R L S”, “[12]” → nothing.
          </p>

          <form onSubmit={addRule} className="flex flex-wrap gap-2 mb-5">
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Say this…"
              maxLength={100}
              className="flex-1 min-w-32 bg-sunken border border-line rounded-lg px-3 py-2 text-sm placeholder:text-soft focus:border-gold outline-none transition"
            />
            <span className="self-center text-soft">→</span>
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="…as this (empty removes it)"
              maxLength={200}
              className="flex-1 min-w-32 bg-sunken border border-line rounded-lg px-3 py-2 text-sm placeholder:text-soft focus:border-gold outline-none transition"
            />
            <button
              type="submit"
              disabled={saving || !pattern.trim()}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-gold hover:bg-gold-strong text-on-gold transition disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add"}
            </button>
          </form>

          {rules.length === 0 ? (
            <p className="text-soft text-sm">No rules yet.</p>
          ) : (
            <ul className="space-y-2">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center justify-between gap-3 bg-sunken rounded-lg px-3 py-2 text-sm"
                >
                  <span className="truncate">
                    <span className="font-mono">{rule.pattern}</span>
                    <span className="text-soft mx-2">→</span>
                    <span className="font-mono text-gold">
                      {rule.replacement || (
                        <em className="text-soft">removed</em>
                      )}
                    </span>
                  </span>
                  <button
                    onClick={() => removeRule(rule.id)}
                    className="text-danger hover:opacity-75 shrink-0 transition"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-surface border border-line rounded-2xl p-6 shadow-sm">
          <h2 className="font-display text-xl mb-1">Podcast feed</h2>
          <p className="text-sm text-soft mb-5">
            Subscribe to your library in any podcast app. Finished audiobooks
            appear as episodes — with resume, speed and offline download for
            free. The link is private; anyone who has it can hear your library.
          </p>

          {!feed ? (
            <p className="text-soft text-sm">Loading…</p>
          ) : !feed.enabled ? (
            <p className="text-danger/90 text-sm">
              Feeds are not enabled on this server (the backend has no service
              role key configured).
            </p>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <input
                  readOnly
                  value={feed.url}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 bg-sunken border border-line rounded-lg px-3 py-2 text-sm font-mono text-soft"
                />
                <button
                  onClick={copyFeed}
                  className="px-4 py-2 rounded-lg text-sm bg-gold hover:bg-gold-strong text-on-gold font-medium transition"
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
              <button
                onClick={handleRotate}
                disabled={rotating}
                className="text-sm text-soft hover:text-ink underline underline-offset-2 transition disabled:opacity-50"
              >
                {rotating ? "Rotating…" : "Rotate URL (revokes the old link)"}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
