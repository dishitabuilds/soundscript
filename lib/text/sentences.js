// Sentence boundary detection.
//
// Splitting on /[.!?]\s/ is wrong in ways you hear immediately once it is read
// aloud: "Dr. Smith" becomes two sentences with a pause after "Dr", and "3.14"
// becomes "3." and "14". Every rule below exists because of a specific way that
// naive split fails.

// Words that routinely end in a period without ending a sentence.
const ABBREVIATIONS = new Set([
  // titles
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "mt",
  "rev",
  "hon",
  "pres",
  "gov",
  "sen",
  "rep",
  "capt",
  "lt",
  "col",
  "gen",
  "sgt",
  // academic / reference
  "vs",
  "etc",
  "al",
  "fig",
  "figs",
  "eq",
  "eqs",
  "no",
  "nos",
  "vol",
  "vols",
  "ch",
  "chap",
  "sec",
  "pp",
  "p",
  "ed",
  "eds",
  "trans",
  "ref",
  "refs",
  "cf",
  "viz",
  "approx",
  "est",
  "resp",
  "incl",
  "cont",
  // organisations
  "inc",
  "ltd",
  "co",
  "corp",
  "dept",
  "univ",
  "assn",
  "bros",
  "mfg",
  // months and days
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "mon",
  "tue",
  "tues",
  "wed",
  "thu",
  "thur",
  "thurs",
  "fri",
  "sat",
  "sun",
  // units and measures
  "min",
  "max",
  "avg",
  "hr",
  "hrs",
  "sec",
  "secs",
  "ft",
  "in",
  "cm",
  "mm",
  "kg",
  "lb",
  "lbs",
  "oz",
]);

const TERMINATORS = ".!?";
const CLOSERS = /["'”’)\]]/;
const OPENERS = /["'“‘(\[]/;

// True when the text immediately before a period is something that ends in a
// period as a matter of spelling rather than as a full stop.
function endsWithAbbreviation(before) {
  const match = /([A-Za-z][A-Za-z.]*)$/.exec(before);
  if (!match) return false;

  const word = match[1];

  // Dotted forms: "e.g", "i.e", "U.S", "a.m", "Ph.D". By the time we are called
  // the trailing period is not yet included, so an interior period is the tell.
  if (word.includes(".")) return true;

  // A lone capital is an initial -- "J. R. R. Tolkien" is one sentence, and
  // treating each initial as a full stop shreds it into four.
  if (word.length === 1 && /[A-Z]/.test(word)) return true;

  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Split text into sentences.
 *
 * Text is assumed to be a single paragraph with newlines already normalised;
 * see clean.js for the step that rejoins PDF line wrapping.
 *
 * @param {string} text
 * @returns {string[]} sentences, in order, with surrounding whitespace trimmed
 */
function splitSentences(text) {
  if (!text) return [];

  const sentences = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!TERMINATORS.includes(ch)) continue;

    // Absorb runs: "?!", "...", "!!!" terminate once, not once per mark.
    let end = i;
    while (end + 1 < text.length && TERMINATORS.includes(text[end + 1])) end++;

    const isLoneDot = ch === "." && end === i;

    // A decimal point sits between two digits: 3.14, not "3." then "14".
    if (
      isLoneDot &&
      /\d/.test(text[i - 1] || "") &&
      /\d/.test(text[i + 1] || "")
    ) {
      continue;
    }

    // Trailing quotes and brackets close the sentence they belong to:
    //   He said "stop." -> the closing quote stays with this sentence.
    let after = end + 1;
    while (after < text.length && CLOSERS.test(text[after])) after++;

    // A terminator glued to the next word is not a boundary -- that is a
    // filename, a URL, or a version number, not the end of a thought.
    if (after < text.length && !/\s/.test(text[after])) continue;

    if (isLoneDot && endsWithAbbreviation(text.slice(start, i))) continue;

    // Whatever follows should look like a fresh start. This is what stops
    // "the U.S. government" from splitting when the abbreviation list misses a
    // case: lowercase after a period usually means the thought continues.
    let j = after;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (
      j < text.length &&
      !(OPENERS.test(text[j]) || /[A-Z0-9]/.test(text[j]))
    ) {
      continue;
    }

    const sentence = text.slice(start, after).trim();
    if (sentence) sentences.push(sentence);
    start = after;
    i = after - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

module.exports = { splitSentences, endsWithAbbreviation, ABBREVIATIONS };
