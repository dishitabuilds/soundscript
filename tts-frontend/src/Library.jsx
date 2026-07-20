import { useState, useEffect, useRef } from "react";
import {
  listDocuments,
  deleteDocument,
  estimateDocument,
  uploadDocument,
  listVoices,
  previewVoice,
} from "./api";

const ACCEPT = ".pdf,.epub,.docx,.txt,.md";

const SOURCE_LABELS = {
  pdf: "PDF",
  epub: "EPUB",
  docx: "DOCX",
  txt: "Text",
  paste: "Pasted text",
};

function formatChars(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${n} chars`;
}

/**
 * Provider + voice selection with a spoken sample.
 *
 * Voice changes matter to the estimate (cache hits are per-voice), so the
 * parent re-quotes whenever the selection changes.
 */
function VoicePicker({ providers, voice, onChange }) {
  const [sampleUrl, setSampleUrl] = useState("");
  const [loadingSample, setLoadingSample] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef(null);

  const provider =
    providers.find((p) => p.id === voice.provider) ||
    providers.find((p) => p.default) ||
    providers[0];

  // Object URLs hold the blob alive; revoke the old one when replaced.
  useEffect(
    () => () => sampleUrl && URL.revokeObjectURL(sampleUrl),
    [sampleUrl],
  );

  const play = async () => {
    setError("");
    setLoadingSample(true);
    try {
      const url = await previewVoice(voice);
      setSampleUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      // Play on the next tick, once the src is set.
      requestAnimationFrame(() => audioRef.current?.play());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingSample(false);
    }
  };

  if (!providers.length) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <select
          value={provider?.id || ""}
          onChange={(e) => {
            const next = providers.find((p) => p.id === e.target.value);
            onChange({
              provider: next.id,
              voiceId: next.defaultVoiceId,
            });
          }}
          className="bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.id === "elevenlabs" ? "ElevenLabs" : "OpenAI"}
              {p.available ? "" : " (no API key)"}
            </option>
          ))}
        </select>

        <select
          value={voice.voiceId || provider?.defaultVoiceId || ""}
          onChange={(e) =>
            onChange({
              ...voice,
              provider: provider.id,
              voiceId: e.target.value,
            })
          }
          className="flex-1 min-w-40 bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink"
        >
          {(provider?.voices || []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.description ? ` — ${v.description}` : ""}
            </option>
          ))}
        </select>

        <button
          onClick={play}
          disabled={loadingSample || !provider?.available}
          className="px-4 py-2 rounded-lg text-sm bg-gold hover:bg-gold-strong text-on-gold font-medium transition disabled:opacity-50"
        >
          {loadingSample ? "Loading…" : "▶ Preview voice"}
        </button>
      </div>

      {sampleUrl && <audio ref={audioRef} src={sampleUrl} className="hidden" />}
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  );
}

export default function Library({ onOpen, onBack }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const [providers, setProviders] = useState([]);
  const [voice, setVoice] = useState({});

  // The confirm step: a file waiting on its quote, then on the user's yes.
  const [pendingFile, setPendingFile] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [uploading, setUploading] = useState(false);

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
    // Voices load once; failure only greys out the picker, never blocks upload.
    listVoices()
      .then((p) => {
        setProviders(p);
        const preferred =
          p.find((x) => x.default && x.available) || p.find((x) => x.available);
        if (preferred)
          setVoice({
            provider: preferred.id,
            voiceId: preferred.defaultVoiceId,
          });
      })
      .catch(() => {});
  }, []);

  const quote = async (file, chosenVoice) => {
    setError("");
    setEstimating(true);
    setEstimate(null);
    try {
      setEstimate(await estimateDocument(file, { voice: chosenVoice }));
    } catch (err) {
      setError(err.message);
      setPendingFile(null);
    } finally {
      setEstimating(false);
    }
  };

  const handleFile = (file) => {
    if (!file) return;
    setPendingFile(file);
    quote(file, voice);
  };

  const changeVoice = (next) => {
    setVoice(next);
    // A different narrator hits a different cache; the quote must follow.
    if (pendingFile) quote(pendingFile, next);
  };

  const confirmUpload = async () => {
    if (!pendingFile) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadDocument(pendingFile, { voice });
      setPendingFile(null);
      setEstimate(null);
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

  const cancelUpload = () => {
    setPendingFile(null);
    setEstimate(null);
    if (fileInput.current) fileInput.current.value = "";
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
    <div className="min-h-screen bg-page text-ink transition-colors px-5 sm:px-6 py-8 sm:py-10">
      <div className="max-w-4xl mx-auto">
        <button
          onClick={onBack}
          className="mb-6 px-4 py-2 rounded-lg bg-surface hover:bg-sunken border border-line text-sm transition"
        >
          ← Back
        </button>

        <h1 className="font-display text-3xl mb-2">Your Library</h1>
        <p className="text-soft mb-8">
          Upload a PDF, EPUB, DOCX or text file and get it back as narrated
          audio.
        </p>

        {!pendingFile && (
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
            onClick={() => fileInput.current?.click()}
            className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition mb-8 ${
              dragging
                ? "border-gold bg-gold/10"
                : "border-line bg-surface hover:bg-sunken"
            }`}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <p className="text-lg font-medium">Drop a document here</p>
            <p className="text-sm text-soft mt-1">
              PDF, EPUB, DOCX, TXT or Markdown — or click to choose a file
            </p>
          </div>
        )}

        {pendingFile && (
          <div className="bg-surface border border-line rounded-2xl p-6 mb-8 shadow-sm">
            <div className="flex items-baseline justify-between mb-4">
              <p className="font-display text-lg truncate">
                {pendingFile.name}
              </p>
              <button
                onClick={cancelUpload}
                className="text-sm text-soft hover:text-ink transition shrink-0 ml-4"
              >
                Cancel
              </button>
            </div>

            <div className="mb-5">
              <p className="text-sm text-soft mb-2">Narrator</p>
              <VoicePicker
                providers={providers}
                voice={voice}
                onChange={changeVoice}
              />
            </div>

            {estimating && (
              <p className="text-soft text-sm">
                Reading the document and pricing it…
              </p>
            )}

            {estimate && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5 text-sm">
                  <div className="bg-sunken rounded-lg p-3">
                    <p className="text-soft text-xs">Characters</p>
                    <p className="font-medium tabular-nums">
                      {estimate.charCount.toLocaleString()}
                    </p>
                  </div>
                  <div className="bg-sunken rounded-lg p-3">
                    <p className="text-soft text-xs">Chunks</p>
                    <p className="font-medium tabular-nums">
                      {estimate.chunks.total}
                      {estimate.chunks.cached > 0 && (
                        <span className="text-ok">
                          {" "}
                          ({estimate.chunks.cached} cached)
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="bg-sunken rounded-lg p-3">
                    <p className="text-soft text-xs">Will bill</p>
                    <p className="font-medium tabular-nums">
                      {estimate.billableChars.toLocaleString()} chars
                    </p>
                  </div>
                  <div className="bg-sunken rounded-lg p-3">
                    <p className="text-soft text-xs">Quota left today</p>
                    <p
                      className={`font-medium tabular-nums ${estimate.fits ? "" : "text-danger"}`}
                    >
                      {estimate.quota.remaining.toLocaleString()} /{" "}
                      {estimate.quota.limit.toLocaleString()}
                    </p>
                  </div>
                </div>

                {!estimate.fits && (
                  <p className="text-danger text-sm mb-4">
                    This document needs more characters than you have left
                    today.
                  </p>
                )}

                <button
                  onClick={confirmUpload}
                  disabled={uploading || !estimate.fits}
                  className="w-full py-3 rounded-xl font-semibold bg-gold hover:bg-gold-strong text-on-gold transition disabled:opacity-50"
                >
                  {uploading
                    ? "Uploading…"
                    : estimate.billableChars === 0
                      ? "Create audiobook (free — fully cached)"
                      : `Create audiobook (${estimate.billableChars.toLocaleString()} chars)`}
                </button>
              </>
            )}
          </div>
        )}

        {error && (
          <p className="mb-6 text-danger text-sm bg-danger/10 border border-danger/30 rounded-lg p-3">
            ❗ {error}
          </p>
        )}

        {loading ? (
          <p className="text-soft">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="text-soft text-center py-8">
            Nothing here yet. Upload a document to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between gap-4 bg-surface hover:bg-sunken border border-line rounded-xl p-4 transition"
              >
                <button
                  onClick={() => onOpen(doc.id)}
                  className="flex-1 text-left min-w-0"
                >
                  <p className="font-medium truncate">{doc.title}</p>
                  <p className="text-sm text-soft mt-0.5">
                    {SOURCE_LABELS[doc.source_type] || doc.source_type} ·{" "}
                    {formatChars(doc.char_count)} ·{" "}
                    {new Date(doc.created_at).toLocaleDateString()}
                  </p>
                </button>

                <button
                  onClick={() => handleDelete(doc.id, doc.title)}
                  className="text-danger hover:opacity-75 text-sm px-3 py-1 shrink-0 transition"
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
