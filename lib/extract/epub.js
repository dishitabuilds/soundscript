// EPUB -> text.
//
// An EPUB is a zip: META-INF/container.xml points at an OPF manifest, the OPF's
// spine lists the reading order, and each spine item is an XHTML document.
// Unlike PDF there is nothing to guess -- paragraphs are real <p> elements and
// there are no running headers to strip -- so the output here skips the PDF
// cleaning heuristics entirely.

const path = require("path");
const AdmZip = require("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const { htmlToText } = require("./html");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // OPF files appear with and without namespace prefixes in the wild; stripping
  // them lets one lookup handle both.
  removeNSPrefix: true,
});

const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

function readEntry(zip, name) {
  // Zip paths are forward-slash by spec; normalise and also strip any leading
  // "./" an author's tooling left behind.
  const clean = name.replace(/\\/g, "/").replace(/^\.\//, "");
  const entry = zip.getEntry(clean);
  return entry ? zip.readAsText(entry) : null;
}

/**
 * @param {Buffer} data
 * @returns {{ text: string, chapterCount: number }}
 */
function extractEpub(data) {
  let zip;
  try {
    zip = new AdmZip(data);
  } catch (err) {
    throw new Error(`Not a readable EPUB (zip damaged: ${err.message}).`);
  }

  const container = readEntry(zip, "META-INF/container.xml");
  if (!container)
    throw new Error("Not an EPUB: missing META-INF/container.xml.");

  const containerDoc = parser.parse(container);
  const rootfile = asArray(containerDoc?.container?.rootfiles?.rootfile).find(
    (r) => r?.["@_full-path"],
  );
  const opfPath = rootfile?.["@_full-path"];
  if (!opfPath) throw new Error("EPUB container.xml names no OPF package.");

  const opfXml = readEntry(zip, opfPath);
  if (!opfXml)
    throw new Error(`EPUB is missing its package file (${opfPath}).`);

  const opf = parser.parse(opfXml);
  const pkg = opf?.package;
  if (!pkg) throw new Error("EPUB package file has no <package> root.");

  const manifest = new Map(
    asArray(pkg.manifest?.item).map((item) => [
      item?.["@_id"],
      { href: item?.["@_href"], mediaType: item?.["@_media-type"] },
    ]),
  );

  // Hrefs in the manifest are relative to the OPF's own directory.
  const opfDir = path.posix.dirname(opfPath.replace(/\\/g, "/"));
  const resolve = (href) =>
    opfDir === "." ? href : path.posix.join(opfDir, href);

  const chapters = [];
  for (const ref of asArray(pkg.spine?.itemref)) {
    const item = manifest.get(ref?.["@_idref"]);
    if (!item?.href) continue;
    // The spine can reference images or the cover page; only documents speak.
    if (item.mediaType && !/xhtml|html|xml/.test(item.mediaType)) continue;

    const html = readEntry(zip, resolve(item.href));
    if (!html) continue;

    const text = htmlToText(html);
    if (text) chapters.push(text);
  }

  if (chapters.length === 0) {
    throw new Error("EPUB contains no readable text in its spine.");
  }

  return { text: chapters.join("\n\n"), chapterCount: chapters.length };
}

module.exports = { extractEpub };
