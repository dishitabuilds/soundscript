// Split a document into chunks small enough for the TTS API.
//
// The API caps input length, so a 40-page chapter cannot be sent in one call.
// Where the splits land is audible: break mid-sentence and the narration hits a
// wall and restarts. So the chunker prefers boundaries in this order --
// paragraph, sentence, clause, word -- and only ever falls to the next when the
// current one cannot fit.
//
// Chunks also carry paragraph position, which the stitching step uses to insert
// a longer pause between paragraphs than between sentences.

const { splitSentences } = require("./sentences");

const DEFAULT_MAX_CHARS = 2000;

/**
 * Break a run of text that is itself longer than maxChars.
 *
 * Prefers clause punctuation, because a break after a comma reads as a pause
 * while a break between two arbitrary words reads as a fault. Falls back to
 * word boundaries, and only ever splits inside a word for a single "word"
 * longer than the whole budget -- a URL or a hash, where there is no good
 * option and dropping text would be worse.
 */
function splitOversized(text, maxChars) {
  const out = [];

  // Keep the punctuation with the fragment it closes.
  const fragments = text.split(/(?<=[,;:])\s+/);

  let current = "";

  const flush = () => {
    if (current.trim()) out.push(current.trim());
    current = "";
  };

  for (const fragment of fragments) {
    if (fragment.length > maxChars) {
      flush();

      let words = fragment.split(/\s+/);
      for (const word of words) {
        if (word.length > maxChars) {
          // Pathological: a single token longer than the budget. Hard-split it
          // rather than emit an oversized chunk the API will reject.
          flush();
          for (let i = 0; i < word.length; i += maxChars) {
            out.push(word.slice(i, i + maxChars));
          }
          continue;
        }
        if (current && current.length + 1 + word.length > maxChars) flush();
        current = current ? `${current} ${word}` : word;
      }
      continue;
    }

    if (current && current.length + 1 + fragment.length > maxChars) flush();
    current = current ? `${current} ${fragment}` : fragment;
  }

  flush();
  return out;
}

/**
 * Pack a paragraph's sentences into chunks of at most maxChars.
 */
function chunkParagraph(paragraph, maxChars) {
  const sentences = splitSentences(paragraph);
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush();
      chunks.push(...splitOversized(sentence, maxChars));
      continue;
    }

    if (current && current.length + 1 + sentence.length > maxChars) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }

  flush();
  return chunks;
}

/**
 * Split cleaned document text into ordered chunks.
 *
 * @param {string} text  Cleaned text; blank lines separate paragraphs.
 * @param {{ maxChars?: number }} [options]
 * @returns {Array<{
 *   idx: number,
 *   text: string,
 *   charCount: number,
 *   paragraphIdx: number,
 *   endsParagraph: boolean
 * }>}
 */
function chunkText(text, options = {}) {
  // ?? not ||: maxChars 0 is invalid and must reach the check below, but || is
  // falsy on 0 and would silently swap in the default instead.
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(`maxChars must be a positive integer, got ${maxChars}`);
  }
  if (!text || !text.trim()) return [];

  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let idx = 0;

  paragraphs.forEach((paragraph, paragraphIdx) => {
    const parts = chunkParagraph(paragraph, maxChars);

    parts.forEach((part, i) => {
      chunks.push({
        idx: idx++,
        text: part,
        charCount: part.length,
        paragraphIdx,
        // Only the last chunk of a paragraph earns the longer pause; the
        // earlier ones are mid-thought and should run straight on.
        endsParagraph: i === parts.length - 1,
      });
    });
  });

  return chunks;
}

module.exports = {
  chunkText,
  chunkParagraph,
  splitOversized,
  DEFAULT_MAX_CHARS,
};
