// client/src/History.jsx

import { useState, useEffect } from "react";
import { supabase } from "./supabase";

export default function History({ user, onBack }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fetch user history
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

  // Delete a single record
  const deleteRecord = async (id) => {
    await supabase.from("tts_conversions").delete().eq("id", id);
    setHistory(history.filter((h) => h.id !== id));
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white px-6 py-10">
      <button
        onClick={onBack}
        className="mb-6 bg-blue-600 px-4 py-2 rounded-md hover:bg-blue-700"
      >
        ← Back
      </button>

      <h1 className="text-3xl font-bold mb-6">Your Conversion History</h1>

      {loading ? (
        <p className="text-gray-400">Loading history...</p>
      ) : history.length === 0 ? (
        <p className="text-gray-400">No conversions yet.</p>
      ) : (
        <div className="space-y-5">
          {history.map((item) => (
            <div
              key={item.id}
              className="bg-gray-800 p-5 rounded-xl border border-gray-700 shadow-lg"
            >
              <p className="text-gray-300 mb-3">
                <span className="font-semibold text-blue-400">Text:</span>{" "}
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
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  Download
                </a>

                <button
                  onClick={() => deleteRecord(item.id)}
                  className="text-red-400 hover:text-red-300"
                >
                  Delete
                </button>
              </div>

              <p className="text-gray-500 text-sm mt-2">
                {new Date(item.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
