const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs/promises");

const {
  stitchChunks,
  withWorkDir,
  probeDuration,
  makeSilence,
  chapterTitle,
} = require("../lib/audio/stitch");

// Real MP3s, built with ffmpeg rather than mocked, because the whole point of
// this module is what ffmpeg does with actual audio.
async function tone(seconds, file) {
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  const run = promisify(execFile);
  const ffmpeg = require("ffmpeg-static");

  await run(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}:sample_rate=44100`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-ac",
    "1",
    file,
  ]);
  return fs.readFile(file);
}

test("chapterTitle truncates on a word boundary", () => {
  assert.strictEqual(chapterTitle("Short one."), "Short one.");

  const long = chapterTitle(
    "This is a considerably longer paragraph opening that will need truncating somewhere",
  );
  assert.ok(long.length <= 61, `too long: ${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.ok(
    !/\s…$/.test(long),
    "should not leave a dangling space before the ellipsis",
  );
});

test("chapterTitle collapses whitespace", () => {
  assert.strictEqual(
    chapterTitle("has\n  ragged\tspacing"),
    "has ragged spacing",
  );
});

test("makeSilence produces audio of the requested length", async () => {
  await withWorkDir(async (dir) => {
    const file = path.join(dir, "s.mp3");
    await makeSilence(0.5, file);
    const duration = await probeDuration(file);
    assert.ok(
      Math.abs(duration - 0.5) < 0.1,
      `expected ~0.5s, got ${duration}`,
    );
  });
});

test("stitching concatenates in order with gaps", async () => {
  await withWorkDir(async (dir) => {
    const a = await tone(1.0, path.join(dir, "a-src.mp3"));
    const b = await tone(1.0, path.join(dir, "b-src.mp3"));
    const c = await tone(1.0, path.join(dir, "c-src.mp3"));

    const chunks = [
      {
        idx: 0,
        buffer: a,
        paragraphIdx: 0,
        endsParagraph: false,
        text: "First chunk.",
      },
      {
        idx: 1,
        buffer: b,
        paragraphIdx: 0,
        endsParagraph: true,
        text: "Second chunk.",
      },
      {
        idx: 2,
        buffer: c,
        paragraphIdx: 1,
        endsParagraph: true,
        text: "Third chunk.",
      },
    ];

    const out = path.join(dir, "out.mp3");
    const result = await stitchChunks(chunks, { outPath: out, workDir: dir });

    // 3s of tone + one 0.35s sentence gap + one 0.75s paragraph gap = ~4.1s.
    // No gap after the last chunk.
    assert.ok(
      Math.abs(result.durationSeconds - 4.1) < 0.4,
      `expected ~4.1s, got ${result.durationSeconds}`,
    );

    assert.ok(result.byteSize > 0, "output should have bytes");
    assert.ok(result.durationSeconds > 0, "output must report a duration");
  });
});

test("a paragraph gap is longer than a sentence gap", async () => {
  await withWorkDir(async (dir) => {
    const a = await tone(0.5, path.join(dir, "a.mp3"));
    const b = await tone(0.5, path.join(dir, "b.mp3"));

    const sentenceGap = await stitchChunks(
      [
        { idx: 0, buffer: a, paragraphIdx: 0, endsParagraph: false, text: "A" },
        { idx: 1, buffer: b, paragraphIdx: 0, endsParagraph: false, text: "B" },
      ],
      { outPath: path.join(dir, "s.mp3"), workDir: dir },
    );

    const paragraphGap = await stitchChunks(
      [
        { idx: 0, buffer: a, paragraphIdx: 0, endsParagraph: true, text: "A" },
        { idx: 1, buffer: b, paragraphIdx: 1, endsParagraph: false, text: "B" },
      ],
      { outPath: path.join(dir, "p.mp3"), workDir: dir },
    );

    assert.ok(
      paragraphGap.durationSeconds > sentenceGap.durationSeconds + 0.2,
      `paragraph break (${paragraphGap.durationSeconds}s) should be audibly longer ` +
        `than a sentence break (${sentenceGap.durationSeconds}s)`,
    );
  });
});

test("chapters mark paragraph starts with cumulative timestamps", async () => {
  await withWorkDir(async (dir) => {
    const one = await tone(1.0, path.join(dir, "1.mp3"));

    const chunks = [
      {
        idx: 0,
        buffer: one,
        paragraphIdx: 0,
        endsParagraph: true,
        text: "Opening paragraph.",
      },
      {
        idx: 1,
        buffer: one,
        paragraphIdx: 1,
        endsParagraph: true,
        text: "Middle paragraph.",
      },
      {
        idx: 2,
        buffer: one,
        paragraphIdx: 2,
        endsParagraph: true,
        text: "Final paragraph.",
      },
    ];

    const result = await stitchChunks(chunks, {
      outPath: path.join(dir, "out.mp3"),
      workDir: dir,
    });

    assert.strictEqual(result.chapters.length, 3, "one chapter per paragraph");
    assert.strictEqual(
      result.chapters[0].startSeconds,
      0,
      "first chapter starts at zero",
    );
    assert.deepStrictEqual(
      result.chapters.map((c) => c.title),
      ["Opening paragraph.", "Middle paragraph.", "Final paragraph."],
    );

    // Each is 1s of tone + a 0.75s paragraph gap, so starts land near 0, 1.75, 3.5.
    assert.ok(Math.abs(result.chapters[1].startSeconds - 1.75) < 0.3);
    assert.ok(Math.abs(result.chapters[2].startSeconds - 3.5) < 0.4);

    // Timestamps must increase, or seeking jumps backwards.
    for (let i = 1; i < result.chapters.length; i++) {
      assert.ok(
        result.chapters[i].startSeconds > result.chapters[i - 1].startSeconds,
        "chapter timestamps must be strictly increasing",
      );
    }
  });
});

test("several chunks in one paragraph produce one chapter", async () => {
  await withWorkDir(async (dir) => {
    const one = await tone(0.4, path.join(dir, "t.mp3"));

    const result = await stitchChunks(
      [
        {
          idx: 0,
          buffer: one,
          paragraphIdx: 0,
          endsParagraph: false,
          text: "Part one.",
        },
        {
          idx: 1,
          buffer: one,
          paragraphIdx: 0,
          endsParagraph: false,
          text: "Part two.",
        },
        {
          idx: 2,
          buffer: one,
          paragraphIdx: 0,
          endsParagraph: true,
          text: "Part three.",
        },
      ],
      { outPath: path.join(dir, "out.mp3"), workDir: dir },
    );

    assert.strictEqual(
      result.chapters.length,
      1,
      "one paragraph is one chapter",
    );
    assert.strictEqual(result.chapters[0].title, "Part one.");
  });
});

test("a single chunk stitches with no trailing silence", async () => {
  await withWorkDir(async (dir) => {
    const one = await tone(1.0, path.join(dir, "t.mp3"));
    const result = await stitchChunks(
      [
        {
          idx: 0,
          buffer: one,
          paragraphIdx: 0,
          endsParagraph: true,
          text: "Only.",
        },
      ],
      { outPath: path.join(dir, "out.mp3"), workDir: dir },
    );
    assert.ok(
      Math.abs(result.durationSeconds - 1.0) < 0.25,
      `expected ~1s with no trailing gap, got ${result.durationSeconds}`,
    );
  });
});

test("stitching nothing is an error", async () => {
  await withWorkDir(async (dir) => {
    await assert.rejects(
      () =>
        stitchChunks([], { outPath: path.join(dir, "x.mp3"), workDir: dir }),
      /Nothing to stitch/,
    );
  });
});

test("withWorkDir cleans up even when the body throws", async () => {
  let captured;
  await assert.rejects(() =>
    withWorkDir(async (dir) => {
      captured = dir;
      await fs.writeFile(path.join(dir, "junk.txt"), "x");
      throw new Error("boom");
    }),
  );
  await assert.rejects(() => fs.access(captured), "work dir should be gone");
});
