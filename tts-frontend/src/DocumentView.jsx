import { useState, useEffect, useRef } from "react";
import { getDocument, streamDocument, retryDocument, signedUrl } from "./api";

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function DocumentView({ documentId, onBack }) {
  const [doc, setDoc] = useState(null);
  const [progress, setProgress] = useState(null);
  const [job, setJob] = useState(null);
  const [asset, setAsset] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const audioRef = useRef(null);

  // Load the finished audio. The library bucket is private, so this needs a
  // signed URL rather than a permanent public link.
  const loadAudio = async (assetRow) => {
    if (!assetRow?.path) return;
    try {
      setAudioUrl(await signedUrl(assetRow.path));
    } catch (err) {
      setError(`Could not load audio: ${err.message}`);
    }
  };

  useEffect(() => {
    let live = true;

    const load = async () => {
      try {
        const data = await getDocument(documentId);
        if (!live) return;

        setDoc(data.document);
        setProgress(data.progress);
        setJob(data.job);
        setAsset(data.asset);
        if (data.asset) loadAudio(data.asset);
      } catch (err) {
        if (live) setError(err.message);
      }
    };

    load();

    // The stream closes itself once the job is terminal, so this is not a
    // permanent connection -- but it must still be torn down if the user
    // navigates away mid-job.
    const stop = streamDocument(
      documentId,
      (event) => {
        if (!live) return;

        if (event.type === "snapshot") {
          setProgress(event.progress);
          setJob(event.job);
          return;
        }

        if (event.type === "chunk") {
          // Track progress from the event itself rather than refetching: the
          // counts are already in the payload, and a request per chunk would
          // undo the point of streaming.
          setProgress((p) =>
            p
              ? {
                  ...p,
                  done: event.done,
                  failed: event.failed,
                  pending: Math.max(
                    0,
                    Number(p.total) - event.done - event.failed,
                  ),
                  processing: 0,
                }
              : p,
          );
          return;
        }

        if (event.type === "assembling") {
          setJob((j) => ({ ...(j || {}), status: "assembling" }));
          return;
        }

        if (event.type === "job") {
          setJob((j) => ({
            ...(j || {}),
            status: event.status,
            error: event.error,
          }));
          // Refetch on finish: the event carries a summary, but the asset row
          // has the chapters and exact duration.
          if (event.status === "succeeded" || event.status === "failed") load();
        }
      },
      (err) => live && setError(err.message),
    );

    return () => {
      live = false;
      stop();
    };
  }, [documentId]);

  const handleRetry = async () => {
    setRetrying(true);
    setError("");
    try {
      await retryDocument(documentId);
      const data = await getDocument(documentId);
      setJob(data.job);
      setProgress(data.progress);
    } catch (err) {
      setError(err.message);
    } finally {
      setRetrying(false);
    }
  };

  const seekTo = (seconds) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    audioRef.current.play();
  };

  if (!doc) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-black via-gray-900 to-blue-950 text-white">
        <p className="text-gray-400">{error || "Loading…"}</p>
      </div>
    );
  }

  const total = Number(progress?.total || 0);
  const done = Number(progress?.done || 0);
  const failed = Number(progress?.failed || 0);
  const percent = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  const running = job?.status === "running" || job?.status === "queued";
  const assembling = job?.status === "assembling";
  const chapters = asset?.chapters || [];

  // The chapter containing the playhead, so the list can show where you are.
  const activeChapter = chapters.reduce(
    (active, c, i) => (currentTime >= c.startSeconds ? i : active),
    0,
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-gray-900 to-blue-950 text-white px-6 py-10">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={onBack}
          className="mb-6 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 text-sm transition"
        >
          ← Library
        </button>

        <h1 className="text-3xl font-bold mb-1">{doc.title}</h1>
        <p className="text-gray-400 mb-8 text-sm">
          {doc.char_count?.toLocaleString()} characters · {total} chunk
          {total === 1 ? "" : "s"}
        </p>

        {(running || assembling) && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
            <div className="flex items-center justify-between mb-3">
              <p className="font-medium">
                {assembling ? "Stitching the audiobook…" : "Synthesising…"}
              </p>
              <p className="text-sm text-gray-400">
                {assembling ? "" : `${done} of ${total}`}
              </p>
            </div>

            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-500"
                style={{ width: assembling ? "100%" : `${percent}%` }}
              />
            </div>

            <p className="text-xs text-gray-500 mt-3">
              {assembling
                ? "Adding pauses between sentences and paragraphs."
                : "You can leave this page; work continues in the background."}
            </p>
          </div>
        )}

        {job?.status === "failed" && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-6 mb-6">
            <p className="font-medium text-red-300 mb-1">This job failed</p>
            <p className="text-sm text-gray-400 mb-4">
              {job.error || "Unknown error."}
            </p>
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 text-sm transition disabled:opacity-50"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
            <p className="text-xs text-gray-500 mt-3">
              Chunks that already succeeded are cached — a retry only redoes
              what failed.
            </p>
          </div>
        )}

        {error && <p className="mb-6 text-red-400 text-sm">❗ {error}</p>}

        {asset && audioUrl && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
            <div className="flex items-baseline justify-between mb-4">
              <p className="font-semibold text-lg">Your audiobook</p>
              <p className="text-sm text-gray-400">
                {formatTime(asset.duration_seconds)}
              </p>
            </div>

            <audio
              ref={audioRef}
              controls
              src={audioUrl}
              onTimeUpdate={(e) => setCurrentTime(e.target.currentTime)}
              className="w-full rounded-lg mb-4"
            />

            <a
              href={audioUrl}
              download={`${doc.title}.mp3`}
              className="text-blue-400 hover:text-blue-300 underline text-sm"
            >
              Download
            </a>
          </div>
        )}

        {chapters.length > 0 && audioUrl && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <p className="font-semibold mb-4">
              Chapters{" "}
              <span className="text-gray-500 font-normal">
                ({chapters.length})
              </span>
            </p>

            <div className="space-y-1">
              {chapters.map((chapter, i) => (
                <button
                  key={i}
                  onClick={() => seekTo(chapter.startSeconds)}
                  className={`w-full flex items-baseline gap-3 text-left px-3 py-2 rounded-lg transition ${
                    i === activeChapter
                      ? "bg-blue-500/20 text-blue-200"
                      : "hover:bg-white/10"
                  }`}
                >
                  <span className="text-xs font-mono text-gray-500 shrink-0 w-12">
                    {formatTime(chapter.startSeconds)}
                  </span>
                  <span className="text-sm truncate">{chapter.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
