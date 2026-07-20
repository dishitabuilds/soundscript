const test = require("node:test");
const assert = require("node:assert");

const { applyRules } = require("../lib/text/pronounce");

test("a word rule only matches whole words", () => {
  const rules = [{ pattern: "AI", replacement: "A I" }];
  assert.strictEqual(
    applyRules("AI helps maintain the plan.", rules),
    "A I helps maintain the plan.",
    "must not rewrite the inside of 'maintain'",
  );
});

test("punctuation patterns match literally", () => {
  const rules = [{ pattern: "[12]", replacement: "" }];
  assert.strictEqual(
    applyRules("As shown in prior work [12], results vary.", rules),
    "As shown in prior work , results vary.",
  );
});

test("regex metacharacters in a pattern are inert", () => {
  const rules = [{ pattern: "C++", replacement: "C plus plus" }];
  assert.strictEqual(
    applyRules("Written in C++ mostly.", rules),
    "Written in C plus plus mostly.",
  );
});

test("longer patterns win over their own prefixes", () => {
  const rules = [
    { pattern: "US", replacement: "United States" },
    { pattern: "US GDP", replacement: "United States G D P" },
  ];
  assert.strictEqual(
    applyRules("US GDP grew.", rules),
    "United States G D P grew.",
  );
});

test("a rule's replacement is not rewritten by an earlier-run rule", () => {
  const rules = [
    { pattern: "TTS", replacement: "text to speech" },
    { pattern: "speech", replacement: "SPEECH" },
  ];
  // Longest pattern first means "speech" ran before the TTS rule introduced
  // the word, so the replacement text survives untouched.
  const out = applyRules("TTS is neat.", rules);
  assert.strictEqual(out, "text to speech is neat.");
});

test("a rule cannot loop on its own replacement", () => {
  const rules = [{ pattern: "ha", replacement: "haha" }];
  assert.strictEqual(applyRules("ha", rules), "haha");
});

test("dollar signs in replacements are literal", () => {
  const rules = [{ pattern: "price", replacement: "US$ amount" }];
  assert.strictEqual(
    applyRules("the price rose", rules),
    "the US$ amount rose",
  );
});

test("all occurrences are replaced", () => {
  const rules = [{ pattern: "RLS", replacement: "row level security" }];
  assert.strictEqual(
    applyRules("RLS on. RLS off.", rules),
    "row level security on. row level security off.",
  );
});

test("no rules means no change", () => {
  assert.strictEqual(applyRules("unchanged", []), "unchanged");
  assert.strictEqual(applyRules("unchanged", null), "unchanged");
});
