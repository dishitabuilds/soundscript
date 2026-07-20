import { useState, useEffect } from "react";
import { supabase } from "./supabase";

export default function History({ user, onBack }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const { data, error } = await supabase
        .from("tts_conversions")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (!error) setHistory(data);
      setLoading(false);
    };

    fetchData();
  }, [user]);

  const deleteRecord = async (id) => {
    await supabase.from("tts_conversions").delete().eq("id", id);
    setHistory(history.filter((h) => h.id !== id));
  };

  return (
    <div className="min-h-screen bg-page text-ink transition-colors px-6 py-10">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={onBack}
          className="mb-6 px-4 py-2 rounded-lg bg-surface hover:bg-sunken border border-line text-sm transition"
        >
          ← Back
        </button>

        <h1 className="font-display text-3xl mb-6">Your Conversion History</h1>

        {loading ? (
          <p className="text-soft">Loading history…</p>
        ) : history.length === 0 ? (
          <p className="text-soft">No conversions yet.</p>
        ) : (
          <div className="space-y-5">
            {history.map((item) => (
              <div
                key={item.id}
                className="bg-surface p-5 rounded-xl border border-line shadow-sm"
              >
                <p className="text-ink mb-3">
                  <span className="font-semibold text-gold">Text:</span>{" "}
                  {item.input_text}
                </p>

                <audio
                  controls
                  src={item.audio_url}
                  className="w-full mb-2 rounded-lg"
                ></audio>

                <div className="flex gap-4">
                  <a
                    href={item.audio_url}
                    download
                    className="text-gold hover:text-gold-strong underline underline-offset-2 text-sm"
                  >
                    Download
                  </a>

                  <button
                    onClick={() => deleteRecord(item.id)}
                    className="text-danger hover:opacity-75 text-sm"
                  >
                    Delete
                  </button>
                </div>

                <p className="text-soft text-sm mt-2">
                  {new Date(item.created_at).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
