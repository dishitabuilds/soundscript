import { useState, useEffect, useRef } from "react";
import { listDocuments, uploadDocument, deleteDocument } from "./api";

function formatChars(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${n} chars`;
}

export default function Library({ onOpen, onBack }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  const refresh = async () => {
    try {
      setDocuments(await listDocuments());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleFile = async (file) => {
    if (!file) return;

    if (file.type !== "application/pdf") {
      return setError("Only PDF files are supported.");
    }

    setError("");
    setUploading(true);

    try {
      const result = await uploadDocument(
        file,
        file.name.replace(/\.pdf$/i, ""),
      );
      await refresh();
      // Straight into the detail view: the job is already running, and the
      // progress is the interesting part.
      onOpen(result.document.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const handleDelete = async (id, title) => {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await deleteDocument(id);
      setDocuments((docs) => docs.filter((d) => d.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-gray-900 to-blue-950 text-white px-6 py-10">
      <div className="max-w-4xl mx-auto">
        <button
          onClick={onBack}
          className="mb-6 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 text-sm transition"
        >
          ← Back
        </button>

        <h1 className="text-3xl font-bold mb-2">Your Library</h1>
        <p className="text-gray-400 mb-8">
          Upload a PDF and get it back as narrated audio.
        </p>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
          onClick={() => !uploading && fileInput.current?.click()}
          className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition mb-8 ${
            dragging
              ? "border-blue-400 bg-blue-500/10"
              : "border-white/20 bg-white/5 hover:bg-white/10"
          } ${uploading ? "opacity-60 cursor-wait" : ""}`}
        >
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />

          {uploading ? (
            <>
              <p className="text-lg font-medium">Reading your PDF…</p>
              <p className="text-sm text-gray-400 mt-1">
                Extracting text, stripping headers, splitting into chunks.
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium">Drop a PDF here</p>
              <p className="text-sm text-gray-400 mt-1">
                or click to choose a file
              </p>
            </>
          )}
        </div>

        {error && (
          <p className="mb-6 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg p-3">
            ❗ {error}
          </p>
        )}

        {loading ? (
          <p className="text-gray-400">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            Nothing here yet. Upload a PDF to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between gap-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl p-4 transition"
              >
                <button
                  onClick={() => onOpen(doc.id)}
                  className="flex-1 text-left min-w-0"
                >
                  <p className="font-medium truncate">{doc.title}</p>
                  <p className="text-sm text-gray-400 mt-0.5">
                    {doc.source_type === "pdf" ? "PDF" : "Pasted text"} ·{" "}
                    {formatChars(doc.char_count)} ·{" "}
                    {new Date(doc.created_at).toLocaleDateString()}
                  </p>
                </button>

                <button
                  onClick={() => handleDelete(doc.id, doc.title)}
                  className="text-red-400 hover:text-red-300 text-sm px-3 py-1 shrink-0 transition"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
