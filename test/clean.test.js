const test = require("node:test");
const assert = require("node:assert");
const {
  cleanPages,
  joinLines,
  findRepeatedFurniture,
  isPageNumberLine,
} = require("../lib/text/clean");

test("recognises page number lines", () => {
  for (const l of ["42", "  7 ", "- 12 -", "Page 4", "Page 4 of 40", "xiv"]) {
    assert.ok(isPageNumberLine(l), `should flag "${l}"`);
  }
  for (const l of ["Chapter 4 begins", "In 1945 the war ended", "A"]) {
    assert.ok(!isPageNumberLine(l), `should not flag "${l}"`);
  }
});

test("finds a running header repeated across pages", () => {
  const pages = [
    ["Intro to Algorithms", "Real content here.", "1"],
    ["Intro to Algorithms", "More real content.", "2"],
    ["Intro to Algorithms", "Yet more content.", "3"],
    ["Intro to Algorithms", "Final content.", "4"],
  ];
  const furniture = findRepeatedFurniture(pages);
  assert.ok(furniture.has("intro to algorithms"));
  assert.ok(!furniture.has("real content here."));
});

test("treats page numbers that vary as the same furniture", () => {
  const pages = [
    ["Page 1 of 40", "Content one."],
    ["Page 2 of 40", "Content two."],
    ["Page 3 of 40", "Content three."],
  ];
  const furniture = findRepeatedFurniture(pages);
  assert.ok(furniture.has("page # of #"), "digits should normalise to #");
});

test("does not strip furniture from a 2-page document", () => {
  // With 2 pages, any repeated line hits 100% -- too little evidence to act on.
  const pages = [
    ["Same line", "Content one."],
    ["Same line", "Content two."],
  ];
  assert.strictEqual(findRepeatedFurniture(pages).size, 0);
});

test("rejoins lines wrapped mid-sentence", () => {
  const out = joinLines([
    "The quick brown fox jumps over the lazy",
    "dog and keeps running until it reaches",
    "the fence at the end of the field.",
  ]);
  assert.ok(!out.includes("\n"), "a wrapped sentence should be one paragraph");
  assert.ok(out.includes("lazy dog"), "wrap point should become a space");
});

test("de-hyphenates words broken across lines", () => {
  const out = joinLines([
    "This is a particularly long exam-",
    "ple of hyphenation across a line break here.",
  ]);
  assert.ok(out.includes("example"), `expected "example", got: ${out}`);
  assert.ok(!out.includes("exam-"), "hyphen should be gone");
});

test("keeps hyphens in real compounds", () => {
  const out = joinLines([
    "They discussed the Anglo-",
    "Saxon period at length during the seminar.",
  ]);
  assert.ok(out.includes("Anglo-Saxon"), `expected compound kept, got: ${out}`);
});

test("blank lines separate paragraphs", () => {
  const out = joinLines([
    "First paragraph text.",
    "",
    "Second paragraph text.",
  ]);
  assert.strictEqual(out, "First paragraph text.\n\nSecond paragraph text.");
});

test("cleanPages strips headers, footers and page numbers", () => {
  const pages = [
    "Data Structures\nA tree is a connected acyclic graph. It has\nno cycles by definition.\n1",
    "Data Structures\nA binary tree limits each node to two\nchildren.\n2",
    "Data Structures\nTraversal visits every node exactly\nonce.\n3",
    "Data Structures\nBalancing keeps the height logarithmic.\n4",
  ];

  const out = cleanPages(pages);

  assert.ok(!/Data Structures/.test(out), `header survived:\n${out}`);
  assert.ok(!/^\s*[1-4]\s*$/m.test(out), `page number survived:\n${out}`);
  assert.ok(out.includes("connected acyclic graph"), "content was lost");
  assert.ok(out.includes("logarithmic"), "content was lost");
});

test("cleanPages joins a sentence that runs across a page break", () => {
  const pages = [
    "Header\nThe sentence begins on this page and\ncontinues without stopping",
    "Header\non the following page to its end.\nAnother sentence here entirely.",
    "Header\nA third page of content follows along.",
  ];
  const out = cleanPages(pages);
  assert.ok(
    /continues without stopping on the following page/.test(out),
    `sentence was broken at the page boundary:\n${out}`,
  );
});

test("cleanPages handles empty input", () => {
  assert.strictEqual(cleanPages([]), "");
  assert.strictEqual(cleanPages(["", "  "]), "");
  assert.strictEqual(cleanPages(null), "");
});

test("cleanPages leaves a single page intact", () => {
  const out = cleanPages(["Just one page of text here.\nNothing to strip."]);
  assert.ok(out.includes("Just one page"));
  assert.ok(out.includes("Nothing to strip"));
});
