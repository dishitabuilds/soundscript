const test = require("node:test");
const assert = require("node:assert");
const AdmZip = require("adm-zip");

const { detectFormat, markdownToText, extractText } = require("../lib/extract");
const { htmlToText, decodeEntities } = require("../lib/extract/html");
const { extractEpub } = require("../lib/extract/epub");
const { extractDocx } = require("../lib/extract/docx");

// Fixtures are built in memory, matching the repo's stance on binary test
// assets: a zip assembled here is reviewable; a committed .epub is opaque.

function makeEpub({ withSpineImage = false } = {}) {
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/epub+zip"));
  zip.addFile(
    "META-INF/container.xml",
    Buffer.from(
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    ),
  );
  zip.addFile(
    "OEBPS/content.opf",
    Buffer.from(
      `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test Book</dc:title></metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    ${withSpineImage ? '<item id="cover" href="cover.png" media-type="image/png"/>' : ""}
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    ${withSpineImage ? '<itemref idref="cover"/>' : ""}
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
    ),
  );
  zip.addFile(
    "OEBPS/ch1.xhtml",
    Buffer.from(
      `<html><head><title>ignored</title><style>p{color:red}</style></head>
<body><h1>Chapter One</h1><p>First paragraph with an &amp; ampersand.</p>
<p>Second&nbsp;paragraph spans
two source lines.</p></body></html>`,
    ),
  );
  zip.addFile(
    "OEBPS/ch2.xhtml",
    Buffer.from(`<html><body><p>Chapter two text.</p></body></html>`),
  );
  zip.addFile("OEBPS/style.css", Buffer.from("p { margin: 0 }"));
  if (withSpineImage) zip.addFile("OEBPS/cover.png", Buffer.alloc(8));
  return zip.toBuffer();
}

function makeDocx() {
  const zip = new AdmZip();
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello world.</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Linked </w:t></w:r>
      <w:hyperlink><w:r><w:t>text survives</w:t></w:r></w:hyperlink>
      <w:r><w:t xml:space="preserve"> nesting.</w:t></w:r>
    </w:p>
    <w:p></w:p>
  </w:body>
</w:document>`,
    ),
  );
  // Real .docx files carry these too; the extractor must not care.
  zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
  return zip.toBuffer();
}

test("detectFormat: PDF by magic bytes, whatever the name", () => {
  const buf = Buffer.from("%PDF-1.7 rest of file");
  assert.strictEqual(detectFormat(buf, "notes.txt"), "pdf");
});

test("detectFormat: tells EPUB and DOCX apart inside the zip", () => {
  assert.strictEqual(detectFormat(makeEpub(), "book.epub"), "epub");
  assert.strictEqual(detectFormat(makeDocx(), "essay.docx"), "docx");
});

test("detectFormat: text only when the extension says text", () => {
  const text = Buffer.from("plain words here");
  assert.strictEqual(detectFormat(text, "notes.txt"), "txt");
  assert.strictEqual(detectFormat(text, "notes.md"), "txt");
  assert.strictEqual(
    detectFormat(text, "notes.exe"),
    null,
    "unknown binary must be refused, not narrated as mojibake",
  );
});

test("htmlToText: paragraphs, entities, stripped chrome", () => {
  const text = htmlToText(
    `<head><title>x</title></head><body><h1>Title</h1>
     <p>One &amp; two.</p><p>Three&#8212;four.</p>
     <script>alert(1)</script></body>`,
  );
  assert.strictEqual(text, "Title\n\nOne & two.\n\nThree—four.");
});

test("decodeEntities: named, decimal, hex; unknown left intact", () => {
  assert.strictEqual(decodeEntities("&lt;&#65;&#x42;&rsquo;"), "<AB’");
  assert.strictEqual(decodeEntities("&notarealone;"), "&notarealone;");
});

test("extractEpub: spine order, skipped images, real paragraphs", () => {
  const { text, chapterCount } = extractEpub(
    makeEpub({ withSpineImage: true }),
  );

  assert.strictEqual(chapterCount, 2, "css and cover contribute no chapters");

  const paragraphs = text.split("\n\n");
  assert.deepStrictEqual(paragraphs, [
    "Chapter One",
    "First paragraph with an & ampersand.",
    "Second paragraph spans two source lines.",
    "Chapter two text.",
  ]);
});

test("extractEpub: rejects a zip that is not an EPUB", () => {
  assert.throws(() => extractEpub(makeDocx()), /container\.xml/);
});

test("extractDocx: paragraphs out, hyperlink runs kept, empties dropped", () => {
  const { text } = extractDocx(makeDocx());
  assert.deepStrictEqual(text.split("\n\n"), [
    "Hello world.",
    "Linked text survives nesting.",
  ]);
});

test("extractDocx: rejects a zip with no document.xml", () => {
  assert.throws(() => extractDocx(makeEpub()), /word\/document\.xml/);
});

test("markdownToText: syntax gone, words kept", () => {
  const md = [
    "# Heading",
    "",
    "Some **bold** and _italic_ and `code`.",
    "",
    "- item one",
    "> quoted line",
    "A [link](https://example.com) in prose.",
  ].join("\n");

  const text = markdownToText(md);
  assert.ok(!text.includes("#"), "heading marker survives");
  assert.ok(!text.includes("**"), "bold marker survives");
  assert.ok(!text.includes("]("), "link URL survives");
  assert.ok(text.includes("Some bold and italic and code."));
  assert.ok(text.includes("A link in prose."));
});

test("extractText: txt path normalises paragraphs", async () => {
  const buf = Buffer.from(
    "First para line one.\r\nStill first.\r\n\r\nSecond para.",
  );
  const { sourceType, text } = await extractText(buf, { filename: "n.txt" });
  assert.strictEqual(sourceType, "txt");
  assert.strictEqual(text, "First para line one. Still first.\n\nSecond para.");
});

test("extractText: epub end to end through the dispatcher", async () => {
  const { sourceType, text } = await extractText(makeEpub(), {
    filename: "book.epub",
  });
  assert.strictEqual(sourceType, "epub");
  assert.ok(text.startsWith("Chapter One"));
});

test("extractText: refuses what it cannot identify", async () => {
  await assert.rejects(
    () =>
      extractText(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), {
        filename: "blob.bin",
      }),
    /Unsupported file type/,
  );
});
