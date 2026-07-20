// Per-user pronunciation fixes, applied to document text before chunking.
//
// TTS mangles the vocabulary of real notes: initialisms ("RLS" should be
// "R L S"), names, citation markers. Users store literal find -> replace pairs
// and they are applied here, before the text is hashed -- so a corrected
// document caches under different keys than an uncorrected one, which is
// exactly the difference in what gets spoken.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern made of word characters should only match whole words: a rule for
 * "AI" must not rewrite the middle of "maintain". Punctuation patterns like
 * "[12]" get no boundaries, since \b beside a bracket refuses to match.
 */
function ruleToRegex(pattern) {
  const escaped = escapeRegex(pattern);
  const wordy = /^\w[\w.]*\w$|^\w$/.test(pattern);
  return new RegExp(wordy ? `\\b${escaped}\\b` : escaped, "g");
}

/**
 * Apply a user's rules to text.
 *
 * Longest pattern first, so a rule for "US GDP" wins over a rule for "US"
 * instead of being ruined by it. Each rule runs once over the whole text;
 * replacements are never re-scanned, so rules cannot cascade or loop.
 *
 * @param {string} text
 * @param {Array<{ pattern: string, replacement: string }>} rules
 * @returns {string}
 */
function applyRules(text, rules) {
  if (!text || !rules?.length) return text;

  const ordered = [...rules].sort(
    (a, b) => b.pattern.length - a.pattern.length,
  );

  let out = text;
  for (const rule of ordered) {
    if (!rule.pattern) continue;
    // $ in a replacement must mean a dollar sign, not a capture reference --
    // users write "US$" not regex.
    out = out.replace(ruleToRegex(rule.pattern), () => rule.replacement);
  }
  return out;
}

module.exports = { applyRules, ruleToRegex };
