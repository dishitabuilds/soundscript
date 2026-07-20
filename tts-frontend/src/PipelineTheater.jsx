import { Fragment, useEffect, useMemo, useState } from "react";

// The wait, staged as a show. Every number here is real: stage states come
// from the job, cells from per-chunk SSE events, captions from what the
// pipeline actually did. Nothing is a fake spinner.

const STITCH_FACTS = [
  "Adding 0.35 seconds of breath after sentences, 0.75 after paragraphs.",
  "Measuring each piece's real length — guessed chapter timestamps drift.",
  "Re-encoding everything to one clean MP3 so every chunk matches.",
  "Writing a chapter mark at the start of every paragraph.",
];

// Bespoke SVG art per stage. Each pivots around real view-box coordinates
// (see index.css). `animate` is true only for the stage currently working, so
// a finished stage sits still and a pending one is a quiet outline.
function StageArt({ id, animate }) {
  const a = (cls) => (animate ? cls : "");
  const common = {
    viewBox: "0 0 24 24",
    className: "svg-art w-8 h-8",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };

  if (id === "read") {
    // An open book; the right leaf folds toward the spine, over and over.
    return (
      <svg {...common}>
        <path d="M12 6 L5 7 L5 18 L12 19 Z" />
        <path d="M12 6 L19 7 L19 18 L12 19 Z" />
        <path
          className={a("art-page")}
          d="M12 6 L19 7 L19 18 L12 19 Z"
          fill="currentColor"
          fillOpacity="0.18"
        />
        <line x1="12" y1="6" x2="12" y2="19" />
      </svg>
    );
  }

  if (id === "chunk") {
    // Scissors snipping around the rivet at (8,12).
    return (
      <svg {...common}>
        <g className={a("art-blade-top")}>
          <line x1="8" y1="12" x2="20" y2="6" />
          <circle cx="5.5" cy="9" r="2.2" />
        </g>
        <g className={a("art-blade-bottom")}>
          <line x1="8" y1="12" x2="20" y2="18" />
          <circle cx="5.5" cy="15" r="2.2" />
        </g>
        <circle cx="8" cy="12" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (id === "voice") {
    // A microphone broadcasting concentric rings.
    return (
      <svg {...common}>
        <circle className={a("art-ring")} cx="12" cy="11" r="5" opacity="0" />
        <circle
          className={a("art-ring art-ring-2")}
          cx="12"
          cy="11"
          r="5"
          opacity="0"
        />
        <circle
          className={a("art-ring art-ring-3")}
          cx="12"
          cy="11"
          r="5"
          opacity="0"
        />
        <rect
          x="9.5"
          y="4"
          width="5"
          height="10"
          rx="2.5"
          fill="currentColor"
          fillOpacity="0.15"
        />
        <path d="M7 11 a5 5 0 0 0 10 0" />
        <line x1="12" y1="16" x2="12" y2="20" />
        <line x1="9" y1="20" x2="15" y2="20" />
      </svg>
    );
  }

  // stitch — running stitches draw in while the needle bobs.
  return (
    <svg {...common}>
      <path className={a("art-stitch")} d="M3 17 Q12 11 21 15" />
      <g className={a("art-needle")}>
        <line x1="15" y1="6" x2="20.5" y2="13.5" />
        <circle cx="14.6" cy="5.4" r="1.1" />
      </g>
    </svg>
  );
}

function Stage({ id, icon, label, state, detail }) {
  const done = state === "done";
  const active = state === "active";
  return (
    // Mobile: a row (icon left, text right). Desktop: a centered column.
    <div className="flex sm:flex-col items-center sm:text-center gap-3 sm:gap-0">
      <div
        className={`shrink-0 w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center border-2 transition ${
          done
            ? "bg-gold/15 border-gold text-gold"
            : active
              ? "bg-gold border-gold text-on-gold shadow-md shadow-gold/20"
              : "bg-sunken border-line text-soft"
        }`}
        aria-hidden={icon ? undefined : true}
      >
        {done ? (
          <svg
            viewBox="0 0 24 24"
            className="w-7 h-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13 l4 4 L19 7" />
          </svg>
        ) : (
          <StageArt id={id} animate={active} />
        )}
      </div>
      <div className="sm:mt-2">
        <p
          className={`text-sm font-medium ${state === "pending" ? "text-soft" : "text-ink"}`}
        >
          {label}
        </p>
        {detail && <p className="text-xs text-soft mt-0.5">{detail}</p>}
      </div>
    </div>
  );
}

export default function PipelineTheater({
  doc,
  progress,
  job,
  chunkStates,
  caption,
}) {
  const total = Number(progress?.total || 0);
  const done = Number(progress?.done || 0);
  const failed = Number(progress?.failed || 0);
  const finished = done + failed;

  const queued = job?.status === "queued";
  const assembling = job?.status === "assembling";
  const voicing = job?.status === "running";

  const percent = total > 0 ? Math.round((finished / total) * 100) : 0;
  const voiceDone = assembling || (total > 0 && finished >= total);

  // Rotate through stitching facts while ffmpeg works; there is no per-step
  // progress to show for it, but there is a true story to tell.
  const [factIdx, setFactIdx] = useState(0);
  useEffect(() => {
    if (!assembling) return;
    const t = setInterval(() => setFactIdx((i) => i + 1), 3500);
    return () => clearInterval(t);
  }, [assembling]);

  // The grid needs a status per cell. Exact statuses arrive as SSE events;
  // for cells finished before we attached, assume the lowest indexes are done
  // -- workers claim strictly in idx order, so it is almost always the truth.
  const cells = useMemo(() => {
    const out = [];
    let assumed = done;
    for (let i = 0; i < total; i++) {
      const known = chunkStates[i];
      if (known) {
        out.push(
          known.status === "failed"
            ? "failed"
            : known.cached
              ? "cached"
              : "done",
        );
      } else if (assumed > 0) {
        out.push("done");
        assumed--;
      } else {
        out.push("pending");
      }
    }
    return out;
  }, [total, done, chunkStates]);

  const stages = [
    {
      id: "read",
      label: "Read",
      state: "done",
      detail: `${Number(doc?.char_count || 0).toLocaleString()} chars`,
    },
    { id: "chunk", label: "Chunk", state: "done", detail: `${total} pieces` },
    {
      id: "voice",
      label: "Voice",
      state: voiceDone ? "done" : "active",
      detail: queued
        ? "queued"
        : voicing
          ? `${finished} of ${total}`
          : voiceDone
            ? `${total} pieces`
            : null,
    },
    {
      id: "stitch",
      label: "Stitch",
      state: assembling ? "active" : "pending",
      detail: assembling ? "with pauses" : null,
    },
  ];

  return (
    <div className="bg-surface border border-line rounded-2xl p-5 sm:p-7 mb-6 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <p className="font-display text-xl sm:text-2xl text-ink">
          {assembling
            ? "Binding your audiobook"
            : queued
              ? "In the queue"
              : "Narrating"}
        </p>
        <p className="text-sm text-soft tabular-nums">
          {assembling ? "finishing" : `${percent}%`}
        </p>
      </div>

      {/* The journey. Mobile: a vertical stepper. Desktop: a horizontal row. */}
      <div className="flex flex-col sm:flex-row sm:items-start mb-6">
        {stages.map((stage, i) => (
          <Fragment key={stage.id}>
            <Stage {...stage} />
            {i < stages.length - 1 && (
              <div className="bg-line ml-[26px] w-px h-5 sm:ml-0 sm:mt-8 sm:w-auto sm:h-px sm:flex-1" />
            )}
          </Fragment>
        ))}
      </div>

      {/* One cell per chunk, lighting up as its audio lands. Dimmer gold means
          it came from the cache -- already paid for, instantly done. */}
      {total > 0 && !assembling && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          {cells.map((state, i) => (
            <span
              key={i}
              title={`chunk ${i + 1}: ${state}`}
              className={`${total > 200 ? "w-2 h-2" : "w-3 h-3"} rounded-sm transition ${
                state === "done"
                  ? "bg-gold cell-pop"
                  : state === "cached"
                    ? "bg-gold/40 cell-pop"
                    : state === "failed"
                      ? "bg-danger cell-pop"
                      : "bg-sunken border border-line"
              }`}
            />
          ))}
        </div>
      )}

      <div className="h-2 bg-sunken rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-gold transition-all duration-500"
          style={{ width: assembling ? "100%" : `${percent}%` }}
        />
      </div>

      {/* Live narration of the work itself. */}
      <p className="text-xs sm:text-sm text-soft italic min-h-5">
        {assembling
          ? STITCH_FACTS[factIdx % STITCH_FACTS.length]
          : caption ||
            "You can leave this page — the work continues without it."}
      </p>
    </div>
  );
}
