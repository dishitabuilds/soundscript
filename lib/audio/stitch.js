// Assemble a document's chunk audio into one narrated file.
//
// Two things happen here that a plain byte-level concatenation cannot do:
//
//   1. Pauses. Chunks are synthesised in isolation, so they butt straight up
//      against each other. Without inserted silence the narration never draws
//      breath, and a paragraph break sounds identical to a mid-sentence join.
//
//   2. Chapters. Paragraph starts become timestamps, so a listener can jump to
//      a section instead of hunting for it. The timestamps have to be measured
//      from the real encoded lengths, silence included -- guessing from
//      character counts drifts within a page.

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const run = promisify(execFile);

// Tuned by ear: long enough to register as a break, short enough not to drag.
const SENTENCE_GAP_S = Number(process.env.SENTENCE_GAP_S || 0.35);
const PARAGRAPH_GAP_S = Number(process.env.PARAGRAPH_GAP_S || 0.75);

const SAMPLE_RATE = 44100;
const BITRATE = "128k";

// Long enough for a big document, short enough that a wedged ffmpeg does not
// hang the worker forever.
const FFMPEG_TIMEOUT_MS = Number(
  process.env.FFMPEG_TIMEOUT_MS || 5 * 60 * 1000,
);

/** Generate a silent MP3 of the given length. */
async function makeSilence(seconds, outPath) {
  await run(
    ffmpegPath,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
      "-t",
      String(seconds),
      "-c:a",
      "libmp3lame",
      "-b:a",
      BITRATE,
      outPath,
    ],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
}

/** Duration of a media file in seconds. */
async function probeDuration(file) {
  const { stdout } = await run(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

// The concat demuxer takes single-quoted paths and treats \ as an escape, so on
// Windows a raw path silently becomes garbage.
function forConcatList(p) {
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

/**
 * Stitch ordered chunk audio into one file.
 *
 * @param {Array<{ idx: number, buffer: Buffer, endsParagraph: boolean,
 *                 paragraphIdx: number, text: string }>} chunks in idx order
 * @param {{ outPath: string, workDir: string }} options
 * @returns {Promise<{ path: string, durationSeconds: number, byteSize: number,
 *                     chapters: Array<{ title: string, startSeconds: number }>,
 *                     timeline: Array<{ idx: number, startSeconds: number,
 *                                       endSeconds: number, paragraphIdx: number }> }>}
 */
async function stitchChunks(chunks, options) {
  if (!chunks.length) throw new Error("Nothing to stitch.");

  const { outPath, workDir } = options;

  const shortGap = path.join(workDir, "gap-short.mp3");
  const longGap = path.join(workDir, "gap-long.mp3");
  await Promise.all([
    makeSilence(SENTENCE_GAP_S, shortGap),
    makeSilence(PARAGRAPH_GAP_S, longGap),
  ]);

  // Write chunk audio out and measure each piece. Durations are needed up front
  // because chapter timestamps are cumulative -- where paragraph 5 starts
  // depends on the exact length of everything before it, including the silence.
  const parts = [];
  for (const chunk of chunks) {
    const file = path.join(
      workDir,
      `chunk-${String(chunk.idx).padStart(5, "0")}.mp3`,
    );
    await fs.writeFile(file, chunk.buffer);
    parts.push({ ...chunk, file, duration: await probeDuration(file) });
  }

  const [shortGapDur, longGapDur] = await Promise.all([
    probeDuration(shortGap),
    probeDuration(longGap),
  ]);

  const lines = [];
  const chapters = [];
  // Where each chunk lands on the finished timeline. This is what read-along
  // playback keys on: the chunk under the playhead is the text being spoken.
  const timeline = [];
  let cursor = 0;
  let seenParagraph = null;

  parts.forEach((part, i) => {
    if (part.paragraphIdx !== seenParagraph) {
      chapters.push({
        title: chapterTitle(part.text),
        startSeconds: Number(cursor.toFixed(3)),
        paragraphIdx: part.paragraphIdx,
      });
      seenParagraph = part.paragraphIdx;
    }

    lines.push(`file '${forConcatList(part.file)}'`);
    timeline.push({
      idx: part.idx,
      startSeconds: Number(cursor.toFixed(3)),
      endSeconds: Number((cursor + (part.duration || 0)).toFixed(3)),
      paragraphIdx: part.paragraphIdx,
    });
    cursor += part.duration || 0;

    // No trailing silence: a pause after the final chunk is just dead air.
    if (i < parts.length - 1) {
      const isParagraphEnd = part.endsParagraph;
      lines.push(
        `file '${forConcatList(isParagraphEnd ? longGap : shortGap)}'`,
      );
      cursor += (isParagraphEnd ? longGapDur : shortGapDur) || 0;
    }
  });

  const listFile = path.join(workDir, "concat.txt");
  await fs.writeFile(listFile, lines.join("\n"), "utf8");

  // Re-encode rather than -c copy.
  //
  // Not for duration: measured both ways, and -c copy reports it correctly --
  // ElevenLabs already ships a Xing header, so the input was never the problem.
  //
  // The reason is that the concat demuxer requires every input to share codec
  // parameters, and -c copy would paste mismatched frames together into a file
  // that plays wrong rather than failing loudly. Today all inputs happen to
  // match (128k mono 44.1k from one voice and model), so -c copy would work --
  // but a different voice, a model change, or a cache entry made under older
  // settings all break that quietly. Re-encoding normalises the lot, and the
  // cost is seconds per document against minutes of synthesis.
  await run(
    ffmpegPath,
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c:a",
      "libmp3lame",
      "-b:a",
      BITRATE,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-write_xing",
      "1",
      outPath,
    ],
    { timeout: FFMPEG_TIMEOUT_MS },
  );

  const [durationSeconds, stat] = await Promise.all([
    probeDuration(outPath),
    fs.stat(outPath),
  ]);

  return {
    path: outPath,
    durationSeconds,
    byteSize: stat.size,
    chapters,
    timeline,
  };
}

/** First sentence-ish of a paragraph, short enough to sit in a chapter list. */
function chapterTitle(text, max = 60) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Run a function with a scratch directory, cleaned up afterwards either way.
 */
async function withWorkDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundscript-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  stitchChunks,
  withWorkDir,
  probeDuration,
  makeSilence,
  chapterTitle,
  SENTENCE_GAP_S,
  PARAGRAPH_GAP_S,
};
