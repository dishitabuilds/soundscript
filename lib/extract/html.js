// Minimal HTML -> prose conversion for EPUB chapter documents.
//
// Not a general HTML renderer: EPUB content documents are a narrow, mostly
// well-formed dialect (XHTML paragraphs, headings, lists), and everything this
// feeds ends up spoken aloud -- layout is irrelevant, only reading order and
// paragraph boundaries matter.

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  shy: "", // soft hyphen: an artefact of typesetting, never of speech
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

// Elements whose end (or self-close) marks a paragraph-level boundary when
// read aloud. Tables get one break per row -- cell-by-cell narration of a
// table is unusable either way, but at least rows stay separated.
const BLOCK_TAGS =
  /^(p|h[1-6]|li|blockquote|figcaption|dt|dd|tr|div|section|article)$/i;

/**
 * @param {string} html one EPUB content document
 * @returns {string} text with paragraphs separated by blank lines
 */
function htmlToText(html) {
  if (!html) return "";

  let s = html
    // Content that must never be narrated, tags AND bodies.
    .replace(/<(script|style|head|svg|math)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Boundary markers go in before tags are stripped, because the tags are the
  // only place the structure lives.
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tag) =>
      BLOCK_TAGS.test(tag) ? "\n\n" : "",
    );

  s = decodeEntities(s);

  // Collapse whitespace inside paragraphs but keep the blank lines that
  // separate them -- downstream chunking splits on exactly those.
  return s
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

module.exports = { htmlToText, decodeEntities };
