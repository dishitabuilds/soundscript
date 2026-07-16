const test = require("node:test");
const assert = require("node:assert");
const { chunkText, splitOversized } = require("../lib/text/chunker");

test("returns nothing for empty input", () => {
  assert.deepStrictEqual(chunkText(""), []);
  assert.deepStrictEqual(chunkText("   \n\n  "), []);
});

test("short text is a single chunk", () => {
  const chunks = chunkText("Hello world.", { maxChars: 100 });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].text, "Hello world.");
  assert.strictEqual(chunks[0].idx, 0);
  assert.strictEqual(chunks[0].paragraphIdx, 0);
  assert.strictEqual(chunks[0].endsParagraph, true);
});

test("never exceeds maxChars", () => {
  const text = Array.from(
    { length: 200 },
    (_, i) => `Sentence number ${i}.`,
  ).join(" ");
  for (const maxChars of [50, 100, 250, 1000]) {
    const chunks = chunkText(text, { maxChars });
    for (const c of chunks) {
      assert.ok(
        c.charCount <= maxChars,
        `chunk of ${c.charCount} exceeds maxChars ${maxChars}`,
      );
    }
  }
});

test("paragraphs are never merged into one chunk", () => {
  const chunks = chunkText("First para.\n\nSecond para.", { maxChars: 1000 });
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].paragraphIdx, 0);
  assert.strictEqual(chunks[1].paragraphIdx, 1);
});

test("only the last chunk of a paragraph ends it", () => {
  const long = Array.from({ length: 20 }, (_, i) => `Sentence ${i}.`).join(" ");
  const chunks = chunkText(long, { maxChars: 60 });
  assert.ok(chunks.length > 1, "expected the paragraph to span several chunks");

  const enders = chunks.filter((c) => c.endsParagraph);
  assert.strictEqual(enders.length, 1);
  assert.strictEqual(enders[0].idx, chunks[chunks.length - 1].idx);
});

test("idx is contiguous and ordered across paragraphs", () => {
  const chunks = chunkText("A one. A two.\n\nB one. B two.\n\nC one.", {
    maxChars: 20,
  });
  chunks.forEach((c, i) => assert.strictEqual(c.idx, i));
});

test("never splits inside a word", () => {
  const text = Array.from(
    { length: 100 },
    () => "antidisestablishmentarianism",
  ).join(" ");
  const chunks = chunkText(text, { maxChars: 60 });
  for (const c of chunks) {
    for (const word of c.text.split(/\s+/)) {
      assert.strictEqual(
        word,
        "antidisestablishmentarianism",
        `found a fragment: "${word}"`,
      );
    }
  }
});

test("a sentence longer than maxChars is broken at clauses", () => {
  const sentence =
    "First clause here, second clause here, third clause here, fourth clause here.";
  const chunks = chunkText(sentence, { maxChars: 30 });

  for (const c of chunks) assert.ok(c.charCount <= 30);
  // Breaking after a comma should leave the comma attached to the earlier part.
  assert.ok(
    chunks.slice(0, -1).some((c) => c.text.endsWith(",")),
    "expected at least one chunk to break at a clause boundary",
  );
});

test("a single token longer than maxChars is hard-split rather than dropped", () => {
  const monster = "x".repeat(250);
  const chunks = chunkText(monster, { maxChars: 100 });
  for (const c of chunks) assert.ok(c.charCount <= 100);
  assert.strictEqual(chunks.map((c) => c.text).join(""), monster);
});

test("abbreviations do not become chunk boundaries", () => {
  const chunks = chunkText("Dr. Smith met Mr. Jones.", { maxChars: 1000 });
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].text, "Dr. Smith met Mr. Jones.");
});

test("no chunk is empty or whitespace-only", () => {
  const text = "One.\n\n\n\nTwo.\n\n   \n\nThree.";
  for (const c of chunkText(text, { maxChars: 10 })) {
    assert.ok(c.text.trim().length > 0);
  }
});

test("no text is lost", () => {
  const text = [
    "The first paragraph has several sentences. Here is another one. And a third.",
    "The second paragraph is shorter. Dr. Smith agrees.",
    "Third: a list, with clauses, that runs on, and on, and on, to force a split.",
  ].join("\n\n");

  const rejoined = chunkText(text, { maxChars: 40 })
    .map((c) => c.text)
    .join(" ");

  assert.strictEqual(
    rejoined.replace(/\s+/g, ""),
    text.replace(/\s+/g, ""),
    "chunks should preserve every non-whitespace character of the source",
  );
});

test("maxChars below 1 is rejected", () => {
  assert.throws(() => chunkText("hi", { maxChars: 0 }), /maxChars/);
});

test("splitOversized keeps clause punctuation attached", () => {
  const parts = splitOversized("alpha, beta, gamma, delta", 12);
  for (const p of parts) assert.ok(p.length <= 12);
  assert.ok(parts[0].endsWith(","));
});
