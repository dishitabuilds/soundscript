// One front door for every supported upload format.
//
// The caller hands over a buffer and a filename; this module decides what the
// file actually is (from its bytes, never from the client-supplied mimetype)
// and returns cleaned text with paragraphs separated by blank lines -- the
// contract the chunker downstream depends on.

const { extractPages } = require("./pdf");
const { extractEpub } = require("./epub");
const { extractDocx } = require("./docx");
const { ocrPdfPages, ocrAvailable } = require("./ocr");
const { cleanPages } = require("../text/clean");

// Formats the API accepts, keyed by what the documents.source_type column
// allows. txt covers markdown too -- the distinction matters to an editor, not
// to a narrator.
const ACCEPTED_EXTENSIONS = {
  ".pdf": "pdf",
  ".epub": "epub",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "txt",
  ".markdown": "txt",
};

function extensionOf(filename = "") {
  const m = /\.[^.]+$/.exec(filename.toLowerCase());
  return m ? m[0] : "";
}

/**
 * Decide the format from the file's own bytes.
 *
 * PDF declares itself in the first four bytes. EPUB and DOCX are both zips, so
 * the zip's contents break the tie: an EPUB carries META-INF/container.xml, a
 * DOCX carries word/document.xml. Anything that is valid UTF-8-ish text falls
 * through to txt.
 *
 * @returns {"pdf"|"epub"|"docx"|"txt"|null}
 */
function detectFormat(buffer, filename = "") {
  if (!buffer || buffer.length < 4) return null;

  if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";

  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    // A zip. Cheap containment probe: both marker paths appear as stored
    // entry names in the central directory, so a substring scan is enough to
    // tell the two apart without parsing the archive twice.
    const head = buffer.toString("latin1");
    if (head.includes("word/document.xml")) return "docx";
    if (
      head.includes("META-INF/container.xml") ||
      head.includes("mimetypeapplication/epub+zip")
    )
      return "epub";
    return null;
  }

  // Not a known binary: accept as text only when the extension agrees, so a
  // random binary renamed to .exe does not get narrated as mojibake.
  const ext = ACCEPTED_EXTENSIONS[extensionOf(filename)];
  if (ext === "txt") return "txt";
  return null;
}

/** Light markdown stripping: pronounce the words, not the syntax. */
function markdownToText(text) {
  return text
    .replace(/^```[\s\S]*?```/gm, "") // fenced code has no spoken form
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "");
}

/**
 * Extract narratable text from an uploaded file.
 *
 * @param {Buffer} buffer
 * @param {{ filename?: string, log?: Function }} [options]
 * @returns {Promise<{ sourceType: string, text: string, ocr?: boolean }>}
 */
async function extractText(buffer, options = {}) {
  const format = detectFormat(buffer, options.filename);

  if (!format) {
    throw new ExtractError(
      "Unsupported file type. Upload a PDF, EPUB, DOCX, or plain text file.",
    );
  }

  if (format === "pdf") {
    const pages = await extractPages(buffer);
    let text = cleanPages(pages);
    let usedOcr = false;

    // No text layer means a scanned document. OCR is the only route to the
    // words, and whether it exists on this server decides the error message.
    if (!text.trim()) {
      if (!ocrAvailable()) {
        throw new ExtractError(
          "This PDF has no text layer (it looks scanned), and OCR is not " +
            "enabled on this server.",
        );
      }
      const ocrPages = await ocrPdfPages(buffer, { log: options.log });
      text = cleanPages(ocrPages);
      usedOcr = true;
      if (!text.trim()) {
        throw new ExtractError(
          "OCR ran but found no readable text in this PDF.",
        );
      }
    }

    return { sourceType: "pdf", text, ocr: usedOcr };
  }

  if (format === "epub") {
    return { sourceType: "epub", text: extractEpub(buffer).text };
  }

  if (format === "docx") {
    return { sourceType: "docx", text: extractDocx(buffer).text };
  }

  // txt / md
  const raw = buffer.toString("utf8").replace(/\r\n/g, "\n");
  const text = markdownToText(raw)
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  if (!text) throw new ExtractError("The file contains no readable text.");
  return { sourceType: "txt", text };
}

/** A user-fixable problem with the uploaded file, worth a 400 not a 500. */
class ExtractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractError";
  }
}

module.exports = {
  extractText,
  detectFormat,
  markdownToText,
  ExtractError,
  ACCEPTED_EXTENSIONS,
};
