const test = require("node:test");
const assert = require("node:assert");
const { buildPdf } = require("./helpers/make-pdf");
const { extractPages, pageCount } = require("../lib/extract/pdf");
const { cleanPages } = require("../lib/text/clean");
const { chunkText } = require("../lib/text/chunker");

test("extracts text from a one-page PDF", async () => {
  const pdf = buildPdf([["Hello world.", "Second line here."]]);
  const pages = await extractPages(pdf);

  assert.strictEqual(pages.length, 1);
  assert.ok(pages[0].includes("Hello world."), `got: ${pages[0]}`);
  assert.ok(pages[0].includes("Second line here."), `got: ${pages[0]}`);
});

test("preserves page boundaries", async () => {
  const pdf = buildPdf([
    ["Page one text."],
    ["Page two text."],
    ["Page three text."],
  ]);
  const pages = await extractPages(pdf);

  assert.strictEqual(pages.length, 3);
  assert.ok(pages[0].includes("one"));
  assert.ok(pages[1].includes("two"));
  assert.ok(pages[2].includes("three"));
});

test("reports page count", async () => {
  const pdf = buildPdf([["a"], ["b"], ["c"], ["d"]]);
  assert.strictEqual(await pageCount(pdf), 4);
});

test("recovers paragraph breaks from vertical spacing", async () => {
  // A PDF contains no blank lines; a paragraph break is drawn as extra vertical
  // space. buildPdf renders an empty entry as a skipped line, which is exactly
  // the double gap a real typesetter leaves between paragraphs.
  const pdf = buildPdf([
    [
      "First paragraph line one.",
      "Still the first paragraph.",
      "",
      "A second paragraph starts.",
    ],
  ]);

  const pages = await extractPages(pdf);
  const lines = pages[0].split("\n");

  assert.ok(
    lines.includes(""),
    `expected a blank line marking the paragraph break, got: ${JSON.stringify(lines)}`,
  );
  assert.strictEqual(lines[0], "First paragraph line one.");
  assert.strictEqual(lines[lines.length - 1], "A second paragraph starts.");
});

test("evenly spaced lines produce no spurious paragraph breaks", async () => {
  const pdf = buildPdf([
    ["Line one.", "Line two.", "Line three.", "Line four."],
  ]);
  const pages = await extractPages(pdf);
  assert.ok(
    !pages[0].split("\n").includes(""),
    `uniform spacing should not look like a paragraph break: ${JSON.stringify(pages[0])}`,
  );
});

test("paragraph breaks survive cleaning into distinct chunks", async () => {
  const pdf = buildPdf([
    [
      "Notes",
      "Rivers carve canyons slowly.",
      "Sediment settles in water.",
      "1",
    ],
    [
      "Notes",
      "Glaciers grind valleys flat.",
      "",
      "Wind shapes dunes over time.",
      "2",
    ],
    ["Notes", "Plate tectonics lift ranges.", "3"],
  ]);

  const text = cleanPages(await extractPages(pdf));
  const paragraphs = text.split(/\n\s*\n/);

  assert.strictEqual(
    paragraphs.length,
    2,
    `expected 2 paragraphs, got:\n${text}`,
  );

  const chunks = chunkText(text, { maxChars: 60 });
  const paragraphIdxs = [...new Set(chunks.map((c) => c.paragraphIdx))];
  assert.deepStrictEqual(
    paragraphIdxs,
    [0, 1],
    "chunks should span both paragraphs",
  );

  // Exactly one chunk per paragraph should carry the longer pause.
  const enders = chunks.filter((c) => c.endsParagraph);
  assert.strictEqual(
    enders.length,
    2,
    "each paragraph should end exactly once",
  );
});

test("rejects empty input", async () => {
  await assert.rejects(() => extractPages(Buffer.alloc(0)), /Empty PDF/);
});

test("rejects data that is not a PDF", async () => {
  await assert.rejects(() =>
    extractPages(Buffer.from("this is not a pdf at all")),
  );
});

test("full pipeline: PDF with headers and page numbers -> clean chunks", async () => {
  // A document shaped like a real textbook chapter: a running header on every
  // page, a page number on every page, prose wrapped mid-sentence, a word
  // hyphenated across a line break, and a sentence spanning a page break.
  const pdf = buildPdf([
    [
      "Introduction to Algorithms",
      "A binary search tree is a data structure that",
      "keeps its keys in sorted order. Lookup is loga-",
      "rithmic in the height of the tree, which",
      "1",
    ],
    [
      "Introduction to Algorithms",
      "matters enormously for large inputs. Balancing",
      "keeps that height small.",
      "",
      "Dr. Knuth discusses this at length in Vol. 3.",
      "2",
    ],
    [
      "Introduction to Algorithms",
      "Traversal visits every node exactly once.",
      "There are three classic orders.",
      "3",
    ],
  ]);

  const pages = await extractPages(pdf);
  assert.strictEqual(pages.length, 3);

  const text = cleanPages(pages);

  // furniture is gone
  assert.ok(
    !/Introduction to Algorithms/.test(text),
    `running header survived:\n${text}`,
  );
  assert.ok(!/^\s*[123]\s*$/m.test(text), `page number survived:\n${text}`);

  // content survived
  assert.ok(/binary search tree/.test(text), `content lost:\n${text}`);
  assert.ok(/Traversal visits every node/.test(text), `content lost:\n${text}`);

  // hyphenation across a line break was repaired
  assert.ok(/logarithmic/.test(text), `de-hyphenation failed:\n${text}`);
  assert.ok(!/loga-\s*rithmic/.test(text), `hyphen survived:\n${text}`);

  // the sentence spanning the page break was rejoined
  assert.ok(
    /which matters enormously/.test(text),
    `sentence broken at page boundary:\n${text}`,
  );

  const chunks = chunkText(text, { maxChars: 120 });
  assert.ok(chunks.length > 0, "expected chunks");

  for (const c of chunks) {
    assert.ok(c.charCount <= 120, `chunk too long: ${c.charCount}`);
    assert.ok(c.text.trim().length > 0, "empty chunk");
  }

  // "Dr." and "Vol." must not have become chunk boundaries
  assert.ok(
    !chunks.some((c) => c.text.trim() === "Dr." || c.text.trim() === "Vol."),
    "an abbreviation was treated as a sentence end",
  );

  // ordering is intact
  chunks.forEach((c, i) => assert.strictEqual(c.idx, i));
});
