const test = require("node:test");
const assert = require("node:assert/strict");
const AdmZip = require("adm-zip");
const { extractText } = require("../lib/extract");
const { extractDocx } = require("../lib/extract/docx");
const { decodeEntities } = require("../lib/extract/html");

test("short UTF-8 TXT documents are valid", async () => {
  const result = await extractText(Buffer.from("Hi"), {
    filename: "short.txt",
  });
  assert.equal(result.text, "Hi");
});

test("TXT preserves literal Markdown-like punctuation", async () => {
  const prose = "#1 is *important* and snake_case stays.";
  const result = await extractText(Buffer.from(prose), {
    filename: "notes.txt",
  });
  assert.equal(result.text, prose);
});

test("binary data disguised as TXT is rejected", async () => {
  await assert.rejects(
    extractText(Buffer.from([0, 1, 2, 3, 255]), { filename: "fake.txt" }),
    /text|UTF-8/i,
  );
});

test("invalid UTF-8 does not silently become replacement characters", async () => {
  await assert.rejects(
    extractText(Buffer.from([0xc3, 0x28, 0x41, 0x42]), { filename: "bad.txt" }),
    /UTF-8/i,
  );
});

test("DOCX reads tables and wrapped paragraphs in document order", () => {
  const zip = new AdmZip();
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      '<w:document xmlns:w="word"><w:body>' +
        "<w:p><w:r><w:t>Before.</w:t></w:r></w:p>" +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell one.</w:t></w:r></w:p></w:tc>" +
        "<w:tc><w:p><w:r><w:t>Cell two.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
        "<w:sdt><w:sdtContent><w:p><w:r><w:t>Wrapped.</w:t></w:r></w:p></w:sdtContent></w:sdt>" +
        "<w:p><w:r><w:t>After.</w:t></w:r></w:p></w:body></w:document>",
    ),
  );
  assert.equal(
    extractDocx(zip.toBuffer()).text,
    "Before.\n\nCell one.\n\nCell two.\n\nWrapped.\n\nAfter.",
  );
});

test("DOCX line breaks keep neighbouring words separate", () => {
  const zip = new AdmZip();
  zip.addFile(
    "word/document.xml",
    Buffer.from(
      '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Hello</w:t><w:br/><w:t>world.</w:t></w:r></w:p></w:body></w:document>',
    ),
  );
  assert.equal(extractDocx(zip.toBuffer()).text, "Hello world.");
});

test("out-of-range HTML entities do not crash extraction", () => {
  assert.equal(
    decodeEntities("Fine &#99999999; text."),
    "Fine &#99999999; text.",
  );
});

test("oversized expanded DOCX entries are rejected before parsing", () => {
  const zip = new AdmZip();
  zip.addFile("word/document.xml", Buffer.alloc(9 * 1024 * 1024, 32));
  assert.throws(
    () => extractDocx(zip.toBuffer()),
    /archive|expanded|large|limit/i,
  );
});
