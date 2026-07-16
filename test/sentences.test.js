const test = require("node:test");
const assert = require("node:assert");
const { splitSentences } = require("../lib/text/sentences");

test("splits plain sentences", () => {
  assert.deepStrictEqual(splitSentences("One. Two. Three."), [
    "One.",
    "Two.",
    "Three.",
  ]);
});

test("handles ! and ?", () => {
  assert.deepStrictEqual(splitSentences("Stop! Who goes there? Nobody."), [
    "Stop!",
    "Who goes there?",
    "Nobody.",
  ]);
});

test("does not split on titles", () => {
  assert.deepStrictEqual(splitSentences("Dr. Smith arrived. He was late."), [
    "Dr. Smith arrived.",
    "He was late.",
  ]);
});

test("does not split on initials", () => {
  assert.deepStrictEqual(
    splitSentences("J. R. R. Tolkien wrote it. It sold."),
    ["J. R. R. Tolkien wrote it.", "It sold."],
  );
});

test("does not split inside decimals", () => {
  assert.deepStrictEqual(splitSentences("Pi is 3.14 exactly. Or close."), [
    "Pi is 3.14 exactly.",
    "Or close.",
  ]);
});

test("does not split on dotted abbreviations", () => {
  assert.deepStrictEqual(splitSentences("Use e.g. this one. Not that one."), [
    "Use e.g. this one.",
    "Not that one.",
  ]);
  assert.deepStrictEqual(splitSentences("The U.S. economy grew. Slowly."), [
    "The U.S. economy grew.",
    "Slowly.",
  ]);
});

test("does not split on etc. mid-sentence", () => {
  assert.deepStrictEqual(splitSentences("Apples, pears, etc. were cheap."), [
    "Apples, pears, etc. were cheap.",
  ]);
});

test("keeps closing quotes with their sentence", () => {
  assert.deepStrictEqual(splitSentences('He said "stop." Then he left.'), [
    'He said "stop."',
    "Then he left.",
  ]);
});

test("treats ellipsis and interrobang as one terminator", () => {
  assert.deepStrictEqual(splitSentences("Wait... What?! Go."), [
    "Wait...",
    "What?!",
    "Go.",
  ]);
});

test("does not split inside a filename or version", () => {
  assert.deepStrictEqual(splitSentences("Open README.md now. Then build."), [
    "Open README.md now.",
    "Then build.",
  ]);
  assert.deepStrictEqual(splitSentences("Version 2.5.1 shipped. It works."), [
    "Version 2.5.1 shipped.",
    "It works.",
  ]);
});

test("handles no trailing terminator", () => {
  assert.deepStrictEqual(splitSentences("First. Second without a period"), [
    "First.",
    "Second without a period",
  ]);
});

test("returns empty for empty input", () => {
  assert.deepStrictEqual(splitSentences(""), []);
  assert.deepStrictEqual(splitSentences("   "), []);
});

test("never loses characters", () => {
  const text =
    'Dr. J. Smith paid $3.50 for it. "Cheap!" he said. Ver. 1.2 e.g. works... Right?';
  const joined = splitSentences(text).join(" ");
  assert.strictEqual(
    joined.replace(/\s+/g, ""),
    text.replace(/\s+/g, ""),
    "reassembled sentences should contain exactly the original characters",
  );
});
