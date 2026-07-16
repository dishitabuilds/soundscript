// PDF -> text, one string per page.
//
// Page boundaries are preserved rather than flattened into one blob, because
// clean.js needs them: running headers and footers can only be found by seeing
// what repeats across pages.

// pdfjs-dist v6 ships ESM only, and this project is CommonJS, so it has to come
// in through a dynamic import. Cached because loading it is not cheap and every
// upload would otherwise pay for it again.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

// A vertical gap this much larger than the usual line spacing reads as a
// paragraph break rather than an ordinary wrap. 1.5 is deliberately cautious:
// merging two paragraphs costs a pause, while splitting one mid-thought puts a
// hard stop in the middle of a sentence.
const PARAGRAPH_GAP_RATIO = 1.5;

/**
 * Rebuild visual lines from positioned text runs, marking paragraph breaks.
 *
 * getTextContent() returns fragments, not lines -- a single line arrives as
 * many items whenever the font or spacing changes mid-line. pdfjs marks the
 * last item of each line with hasEOL, which is its own layout analysis and
 * better than anything reconstructed from coordinates here.
 *
 * Paragraphs are a different problem. A PDF has no concept of one, and contains
 * no blank lines to find -- the break is drawn as extra vertical space between
 * two baselines. So the spacing is measured: the median gap is what this page
 * calls a line, and anything markedly bigger is a paragraph boundary, emitted
 * as a blank line for the text layer downstream.
 */
function itemsToText(items) {
  const lines = [];
  let current = "";
  let y = null;

  for (const item of items) {
    if (typeof item.str !== "string") continue;

    // transform[5] is the baseline's y. Taken from the first fragment of the
    // line, since later fragments on the same line share it.
    if (y === null && Array.isArray(item.transform)) y = item.transform[5];

    current += item.str;

    if (item.hasEOL) {
      lines.push({ text: current, y });
      current = "";
      y = null;
    }
  }

  if (current.trim()) lines.push({ text: current, y });
  if (lines.length === 0) return "";

  // PDF y grows upward, so moving down a page is a decreasing y: the gap is
  // previous minus current.
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1].y;
    const b = lines[i].y;
    if (typeof a === "number" && typeof b === "number" && a - b > 0)
      gaps.push(a - b);
  }

  const sorted = [...gaps].sort((x, z) => x - z);

  // A low percentile, not the median or the mean.
  //
  // Both of those are dragged upward by the very gaps being looked for. On a
  // short page the effect is fatal: gaps of [14, 28] have a median of 28, so
  // nothing can exceed 28 * 1.5 and the one real paragraph break is invisible.
  // Line spacing within a paragraph is the *smallest* recurring gap, so the
  // bottom quartile lands on it and stays there however many breaks the page
  // holds. Not the outright minimum, which a subscript or an inline formula
  // would drag down.
  const normalGap = sorted.length
    ? sorted[Math.floor(sorted.length * 0.25)]
    : 0;

  const out = [];
  lines.forEach((line, i) => {
    if (i > 0 && normalGap > 0) {
      const a = lines[i - 1].y;
      const b = line.y;
      if (
        typeof a === "number" &&
        typeof b === "number" &&
        a - b > normalGap * PARAGRAPH_GAP_RATIO
      ) {
        out.push("");
      }
    }
    out.push(line.text);
  });

  return out.join("\n");
}

/**
 * Normalise input to the Uint8Array pdfjs demands.
 *
 * Buffer extends Uint8Array, so `data instanceof Uint8Array` is true for a
 * Buffer and cannot tell the two apart -- yet pdfjs rejects Buffer by name.
 * Buffer.isBuffer is the only reliable check.
 */
function toUint8Array(data) {
  if (Buffer.isBuffer(data)) {
    // byteOffset and byteLength are load-bearing: Node allocates small Buffers
    // as views into a shared pool, so new Uint8Array(data.buffer) would hand
    // over the whole pool -- unrelated buffers included -- instead of this PDF.
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/**
 * Extract text from a PDF.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {Promise<string[]>} text of each page, in order
 */
async function extractPages(data) {
  if (!data || data.length === 0) throw new Error("Empty PDF data.");

  const pdfjs = await loadPdfjs();

  // The task, not the document, owns teardown: destroy() lives here in pdfjs v6.
  // Holding the reference is what lets the finally block release the worker even
  // when parsing throws.
  const task = pdfjs.getDocument({
    data: toUint8Array(data),
    // Off: both fetch remote assets, which a server-side parse should never do
    // on behalf of an uploaded file.
    useSystemFonts: false,
    isEvalSupported: false,
    // Quiet -- pdfjs is chatty about recoverable oddities in real-world PDFs.
    verbosity: 0,
  });

  try {
    const doc = await task.promise;
    const pages = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        pages.push(itemsToText(content.items));
      } finally {
        page.cleanup();
      }
    }

    return pages;
  } finally {
    await task.destroy();
  }
}

/**
 * How many pages a PDF has, without pulling its text.
 * @param {Buffer|Uint8Array} data
 * @returns {Promise<number>}
 */
async function pageCount(data) {
  if (!data || data.length === 0) throw new Error("Empty PDF data.");

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: toUint8Array(data),
    verbosity: 0,
  });

  try {
    const doc = await task.promise;
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

module.exports = { extractPages, pageCount, itemsToText };
