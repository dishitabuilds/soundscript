// DOCX -> text.
//
// A .docx is a zip whose word/document.xml holds the body as a flat list of
// <w:p> paragraphs; visible text lives in <w:t> runs nested somewhere inside
// each. Paragraph boundaries are explicit, so like EPUB this skips the PDF
// cleaning heuristics.

const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  // Word interleaves plain runs with hyperlinks, smart tags and revision
  // wrappers inside one paragraph. Without preserveOrder the parser groups
  // children by tag name and the words come out shuffled -- order is the one
  // thing narration cannot lose.
  preserveOrder: true,
  // Word wraps meaningful whitespace in xml:space="preserve" runs; trimming
  // values would glue words together at run boundaries.
  trimValues: false,
});

const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

// In preserveOrder mode every element is { tag: [children], ":@": attrs } and
// text is { "#text": "..." }.
function textOf(children) {
  let s = "";
  for (const child of asArray(children)) {
    if (child && typeof child === "object" && "#text" in child)
      s += String(child["#text"]);
  }
  return s;
}

/**
 * Collect the text of every <t> descendant, in document order, walking through
 * whatever wrappers Word nested the runs in.
 */
function collectText(nodes, out) {
  for (const node of asArray(nodes)) {
    if (!node || typeof node !== "object") continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === ":@" || key === "#text") continue;
      if (key === "t") out.push(textOf(value));
      else if (key === "tab") out.push(" ");
      else collectText(value, out);
    }
  }
}

/** First child list with the given tag among a preserveOrder node list. */
function childrenOf(nodes, tag) {
  for (const node of asArray(nodes)) {
    if (node && typeof node === "object" && tag in node) return node[tag];
  }
  return null;
}

/**
 * @param {Buffer} data
 * @returns {{ text: string }}
 */
function extractDocx(data) {
  let zip;
  try {
    zip = new AdmZip(data);
  } catch (err) {
    throw new Error(`Not a readable DOCX (zip damaged: ${err.message}).`);
  }

  const entry = zip.getEntry("word/document.xml");
  if (!entry) throw new Error("Not a DOCX: missing word/document.xml.");

  const tree = parser.parse(zip.readAsText(entry));
  const body = childrenOf(childrenOf(tree, "document"), "body");
  if (!body) throw new Error("DOCX has no document body.");

  const paragraphs = [];
  for (const node of asArray(body)) {
    if (!node || typeof node !== "object" || !("p" in node)) continue;
    const runs = [];
    collectText(node.p, runs);
    const text = runs.join("").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push(text);
  }

  if (paragraphs.length === 0) {
    throw new Error("DOCX contains no readable text.");
  }

  return { text: paragraphs.join("\n\n") };
}

module.exports = { extractDocx };
