// Turn extracted PDF text into prose worth reading aloud.
//
// A PDF has no idea what a paragraph is. Extraction yields one line per visual
// line, with the running header repeated on all 40 pages, page numbers stranded
// on their own lines, and words hyphenated wherever the typesetter happened to
// run out of column. Feeding that straight to TTS narrates the header forty
// times and reads "exam- ple" as two words.
//
// Every rule here is a heuristic. They are tuned for prose (textbooks, papers,
// notes) and will not do anything sensible with a spreadsheet.

// A line must appear on at least this share of pages to count as furniture
// rather than content.
const REPEAT_THRESHOLD = 0.5;

// Only the top and bottom of a page can hold a running header or footer.
const EDGE_LINES = 3;

// Below this share of the median line length, a line is short enough to be the
// last line of a paragraph rather than a mid-paragraph wrap.
const SHORT_LINE_RATIO = 0.6;

// Collapse a line to a form that still matches when the page number inside it
// changes: "Page 3 of 40" and "Page 4 of 40" are the same furniture.
function normaliseForRepeatCheck(line) {
  return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

function isPageNumberLine(line) {
  const t = line.trim();
  if (!t) return false;
  return (
    /^\d{1,4}$/.test(t) || // 42
    /^[-–—]\s*\d{1,4}\s*[-–—]$/.test(t) || // - 42 -
    /^page\s+\d{1,4}(\s+of\s+\d{1,4})?$/i.test(t) || // Page 4 of 40
    /^[ivxlcdm]{1,7}$/i.test(t) // roman numerals in front matter
  );
}

/**
 * Find running headers and footers by looking for lines that repeat near the
 * edge of many pages. Content does not usually appear verbatim at the top of
 * half the pages in a document; a running header always does.
 *
 * @param {string[][]} pageLines lines of each page
 * @returns {Set<string>} normalised lines to drop
 */
function findRepeatedFurniture(pageLines) {
  const furniture = new Set();

  // With only a couple of pages there is no repetition to measure, and a
  // threshold over 2 pages would delete real content.
  if (pageLines.length < 3) return furniture;

  const counts = new Map();

  for (const lines of pageLines) {
    const edges = [...lines.slice(0, EDGE_LINES), ...lines.slice(-EDGE_LINES)];

    // Count each distinct line once per page, so a word repeated within one
    // page does not look like a header.
    const seen = new Set();
    for (const line of edges) {
      const key = normaliseForRepeatCheck(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const needed = Math.ceil(pageLines.length * REPEAT_THRESHOLD);
  for (const [key, count] of counts) {
    if (count >= needed) furniture.add(key);
  }

  return furniture;
}

/**
 * Rejoin lines that a PDF wrapped mid-sentence, and split where a paragraph
 * genuinely ended.
 *
 * Two signals mark a paragraph end: a blank line (reliable, when the extractor
 * gives them) and a line noticeably shorter than the others that closes on a
 * terminator (a best guess, for the many PDFs that give none).
 */
function joinLines(lines) {
  const widths = lines.filter((l) => l.trim()).map((l) => l.trim().length);
  if (widths.length === 0) return "";

  const sorted = [...widths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const shortEnough = median * SHORT_LINE_RATIO;

  const paragraphs = [];
  let current = "";

  const flush = () => {
    const t = current.replace(/\s+/g, " ").trim();
    if (t) paragraphs.push(t);
    current = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      flush();
      continue;
    }

    if (current.endsWith("-")) {
      // A trailing hyphen is usually the typesetter breaking a word across
      // lines, so the halves rejoin with no hyphen. A capital after it suggests
      // a real compound (a proper noun), so the hyphen stays.
      if (/^[a-z]/.test(line)) current = current.slice(0, -1) + line;
      else current += line;
    } else {
      current = current ? `${current} ${line}` : line;
    }

    const isLast = i === lines.length - 1;
    const endsSentence = /[.!?]["'”’)\]]?$/.test(line);
    const isShort = line.length < shortEnough;

    if (isLast || (endsSentence && isShort)) flush();
  }

  flush();
  return paragraphs.join("\n\n");
}

/**
 * Clean extracted page text into paragraph-separated prose.
 *
 * @param {string[]} pages raw text of each page, in order
 * @returns {string} cleaned text, paragraphs separated by blank lines
 */
function cleanPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return "";

  // Blank lines are kept: extract.js emits them where it measured a paragraph
  // break, and they are the only explicit paragraph signal there is. Dropping
  // them here -- as this did -- silently reduced every document to one
  // paragraph and left joinLines guessing from line lengths alone.
  const pageLines = pages.map((page) =>
    (page || "").split(/\r?\n/).map((l) => l.replace(/\s+$/, "")),
  );

  // Furniture lives at the top and bottom of the printed page, so the edge
  // window is counted over real lines; blanks would push a header out of range.
  const furniture = findRepeatedFurniture(
    pageLines.map((lines) => lines.filter((l) => l.trim().length > 0)),
  );

  const kept = [];
  for (const lines of pageLines) {
    const content = lines.filter((l) => l.trim().length > 0);

    const body = lines.filter((line) => {
      if (!line.trim()) return true; // a paragraph break, not a candidate

      const position = content.indexOf(line);
      const nearEdge =
        position < EDGE_LINES || position >= content.length - EDGE_LINES;

      if (isPageNumberLine(line)) return false;
      if (nearEdge && furniture.has(normaliseForRepeatCheck(line)))
        return false;
      return true;
    });

    // Pages are concatenated with no separator on purpose. A page break is not
    // a paragraph break -- prose runs straight across one -- so inserting a
    // blank line here would cut every sentence unlucky enough to span two
    // pages. joinLines already decides paragraph ends from line length and
    // terminators, and those signals work identically at a page boundary.
    kept.push(...body);
  }

  return joinLines(kept);
}

module.exports = {
  cleanPages,
  joinLines,
  findRepeatedFurniture,
  isPageNumberLine,
  normaliseForRepeatCheck,
};
