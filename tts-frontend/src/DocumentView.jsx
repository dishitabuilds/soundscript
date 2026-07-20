import { useState, useEffect, useRef, useMemo } from "react";
import {
  getDocument,
  getDocumentText,
  streamDocument,
  retryDocument,
  savePosition,
  signedUrl,
} from "./api";
import PipelineTheater from "./PipelineTheater";
import Loading from "./Loading";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// Position writes are cheap but not free; once per this interval is plenty for
// a resume feature that only needs to be roughly right.
const POSITION_SAVE_MS = 5000;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The document text, highlighted in step with playback.
 *
 * asset.timeline says when each chunk is spoken; the chunks endpoint says what
 * it says. Joined by idx, grouped into paragraphs for display.
 */
function ReadAlong({ chunks, timeline, currentTime, onSeek }) {
  const activeRef = useRef(null);

  const timelineByIdx = useMemo(
    () => new Map((timeline || []).map((t) => [t.idx, t])),
    [timeline],
  );

  // The chunk being spoken: the last one whose start is behind the playhead.
  const activeIdx = useMemo(() => {
    let active = -1;
    for (const t of timeline || []) {
      if (t.startSeconds <= currentTime + 0.05) active = t.idx;
      else break;
    }
    return active;
  }, [timeline, currentTime]);

  const paragraphs = useMemo(() => {
    const groups = [];
    let current = null;
    for (const chunk of chunks) {
      if (!current || chunk.paragraph_idx !== current.paragraphIdx) {
        current = { paragraphIdx: chunk.paragraph_idx, chunks: [] };
        groups.push(current);
      }
      current.chunks.push(chunk);
    }
    return groups;
  }, [chunks]);

  // Keep the spoken line in view without yanking the page around.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  return (
    <div className="bg-surface border border-line rounded-2xl p-6 max-h-96 overflow-y-auto shadow-sm">
      <p className="font-display text-lg mb-4">
        Read along{" "}
        <span className="text-soft font-sans font-normal text-sm">
          — click any sentence to jump there
        </span>
      </p>

      <div className="space-y-4 text-[15px] leading-relaxed">
        {paragraphs.map((para) => (
          <p key={para.paragraphIdx}>
            {para.chunks.map((chunk) => {
              const entry = timelineByIdx.get(chunk.idx);
              const isActive = chunk.idx === activeIdx;
              return (
                <span
                  key={chunk.idx}
                  ref={isActive ? activeRef : null}
                  onClick={() => entry && onSeek(entry.startSeconds)}
                  className={`cursor-pointer transition rounded px-0.5 ${
                    isActive
                      ? "bg-gold/25 text-ink"
                      : "text-soft hover:bg-sunken hover:text-ink"
                  }`}
                >
                  {chunk.text}{" "}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </div>
  );
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
  const [rate, setRate] = useState(1);
  const [chunks, setChunks] = useState(null);

  // Fuel for the pipeline theater: exactly which chunks have landed, and a
  // one-line caption narrating the most recent event.
  const [chunkStates, setChunkStates] = useState({});
  const [caption, setCaption] = useState("");

  const audioRef = useRef(null);
  const resumeAtRef = useRef(0);
  const lastSavedRef = useRef(0);
  // Mirrors currentTime for the unmount save: the <audio> element is unmounted
  // by the time cleanup runs, but the last observed position is not.
  const currentTimeRef = useRef(0);

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
        // Stored before the audio element exists; applied on loadedmetadata.
        resumeAtRef.current = Number(data.position?.position_seconds) || 0;
        if (data.asset) loadAudio(data.asset);

        // The read-along needs the text only once the audio has a timeline.
        if (data.asset?.timeline?.length) {
          getDocumentText(documentId)
            .then((c) => live && setChunks(c))
            .catch(() => {}); // read-along is an extra, never an error state
        }
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

          setChunkStates((s) => ({
            ...s,
            [event.idx]: { status: event.status, cached: event.cached },
          }));
          setCaption(
            event.status === "failed"
              ? `Chunk ${event.idx + 1} hit a problem — it will be retried.`
              : event.cached
                ? `Chunk ${event.idx + 1} was already in your cache — free.`
                : `Chunk ${event.idx + 1} narrated.`,
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
          // has the chapters, timeline and exact duration.
          if (event.status === "succeeded" || event.status === "failed") load();
        }
      },
      (err) => live && setError(err.message),
    );

    return () => {
      live = false;
      stop();
      // Best-effort parting save so "resume" reflects where they actually left.
      const t = currentTimeRef.current;
      if (t > 1) savePosition(documentId, t).catch(() => {});
    };
  }, [documentId]);

  const seekTo = (seconds) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    audioRef.current.play();
  };

  const skip = (delta) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(
      0,
      audioRef.current.currentTime + delta,
    );
  };

  const changeRate = (r) => {
    setRate(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
  };

  const handleTimeUpdate = (e) => {
    const t = e.target.currentTime;
    setCurrentTime(t);
    currentTimeRef.current = t;
    if (Date.now() - lastSavedRef.current > POSITION_SAVE_MS) {
      lastSavedRef.current = Date.now();
      savePosition(documentId, t).catch(() => {});
    }
  };

  const handleLoadedMetadata = (e) => {
    e.target.playbackRate = rate;
    const resume = resumeAtRef.current;
    // Resuming at the very end would look like a broken player; near-complete
    // documents start over instead.
    if (resume > 5 && resume < e.target.duration - 5) {
      e.target.currentTime = resume;
      setCurrentTime(resume);
    }
    resumeAtRef.current = 0;
  };

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

  if (!doc) {
    return error ? (
      <div className="min-h-screen flex items-center justify-center bg-page text-ink px-6">
        <p className="text-danger text-center">{error}</p>
      </div>
    ) : (
      <Loading message="Opening…" />
    );
  }

  const total = Number(progress?.total || 0);

  const running = job?.status === "running" || job?.status === "queued";
  const assembling = job?.status === "assembling";
  const chapters = asset?.chapters || [];

  // The chapter containing the playhead, so the list can show where you are.
  const activeChapter = chapters.reduce(
    (active, c, i) => (currentTime >= c.startSeconds ? i : active),
    0,
  );

  return (
    <div className="min-h-screen bg-page text-ink transition-colors px-5 sm:px-6 py-8 sm:py-10">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={onBack}
          className="mb-6 px-4 py-2 rounded-lg bg-surface hover:bg-sunken border border-line text-sm transition"
        >
          ← Library
        </button>

        <h1 className="font-display text-3xl mb-1">{doc.title}</h1>
        <p className="text-soft mb-8 text-sm">
          {doc.char_count?.toLocaleString()} characters · {total} chunk
          {total === 1 ? "" : "s"}
        </p>

        {(running || assembling) && (
          <PipelineTheater
            doc={doc}
            progress={progress}
            job={job}
            chunkStates={chunkStates}
            caption={caption}
          />
        )}

        {job?.status === "failed" && (
          <div className="bg-danger/10 border border-danger/30 rounded-2xl p-6 mb-6">
            <p className="font-medium text-danger mb-1">This job failed</p>
            <p className="text-sm text-soft mb-4">
              {job.error || "Unknown error."}
            </p>
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="px-4 py-2 rounded-lg bg-surface hover:bg-sunken border border-line text-sm transition disabled:opacity-50"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
            <p className="text-xs text-soft mt-3">
              Chunks that already succeeded are cached — a retry only redoes
              what failed.
            </p>
          </div>
        )}

        {error && <p className="mb-6 text-danger text-sm">❗ {error}</p>}

        {asset && audioUrl && (
          <div className="bg-surface border border-line rounded-2xl p-6 mb-6 shadow-sm">
            <div className="flex items-baseline justify-between mb-4">
              <p className="font-display text-lg">Your audiobook</p>
              <p className="text-sm text-soft tabular-nums">
                {formatTime(currentTime)} / {formatTime(asset.duration_seconds)}
              </p>
            </div>

            <audio
              ref={audioRef}
              controls
              src={audioUrl}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onPause={(e) =>
                savePosition(documentId, e.target.currentTime).catch(() => {})
              }
              className="w-full rounded-lg mb-4"
            />

            <div className="flex flex-wrap items-center gap-2 mb-4">
              <button
                onClick={() => skip(-15)}
                className="px-3 py-1.5 rounded-lg bg-sunken hover:bg-page border border-line text-sm transition"
              >
                ↺ 15s
              </button>
              <button
                onClick={() => skip(15)}
                className="px-3 py-1.5 rounded-lg bg-sunken hover:bg-page border border-line text-sm transition"
              >
                15s ↻
              </button>

              <div className="w-px h-6 bg-line mx-1" />

              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => changeRate(s)}
                  className={`px-3 py-1.5 rounded-lg border text-sm transition ${
                    rate === s
                      ? "bg-gold text-on-gold border-gold font-medium"
                      : "bg-sunken hover:bg-page border-line"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </div>

            <a
              href={audioUrl}
              download={`${doc.title}.mp3`}
              className="text-gold hover:text-gold-strong underline underline-offset-2 text-sm"
            >
              Download
            </a>
          </div>
        )}

        {chunks?.length > 0 && asset?.timeline?.length > 0 && audioUrl && (
          <div className="mb-6">
            <ReadAlong
              chunks={chunks}
              timeline={asset.timeline}
              currentTime={currentTime}
              onSeek={seekTo}
            />
          </div>
        )}

        {chapters.length > 0 && audioUrl && (
          <div className="bg-surface border border-line rounded-2xl p-6 shadow-sm">
            <p className="font-display text-lg mb-4">
              Chapters{" "}
              <span className="text-soft font-sans font-normal text-sm">
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
                      ? "bg-gold/15 text-ink border border-gold/40"
                      : "hover:bg-sunken border border-transparent"
                  }`}
                >
                  <span className="text-xs font-mono text-soft shrink-0 w-12 tabular-nums">
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
