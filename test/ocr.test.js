const { test } = require("node:test");
const assert = require("node:assert/strict");
const tesseract = require("tesseract.js");
const { imagePdf } = require("./helpers/image-pdf");
const { buildPdf } = require("./helpers/make-pdf");
const { extractText } = require("../lib/extract");
const { extractPages } = require("../lib/extract/pdf");

test("PDF parsing preserves the original upload buffer for OCR and storage", async () => {
  const data = imagePdf();
  const original = Buffer.from(data);
  await extractPages(data);
  assert.deepEqual(data, original);
});

test("mixed PDFs OCR the scanned page without dropping text pages", async (t) => {
  let recognized = 0,
    terminated = false;
  t.mock.method(tesseract, "createWorker", async () => ({
    recognize: async (image) => {
      assert.ok(Buffer.isBuffer(image) && image.length > 100);
      recognized++;
      return { data: { text: "SOUNDSCRIPT OCR CHECK" } };
    },
    terminate: async () => {
      terminated = true;
    },
  }));
  const result = await extractText(imagePdf({ mixed: true }), {
    filename: "mixed.pdf",
  });
  assert.equal(result.ocr, true);
  assert.equal(recognized, 1);
  assert.ok(terminated);
  assert.match(result.text, /SOUNDSCRIPT OCR CHECK/);
  assert.match(result.text, /TEXT PAGE STAYS/);
  assert.ok(result.text.indexOf("OCR") < result.text.indexOf("TEXT PAGE"));
});

test("text PDFs and deliberately blank pages never initialize OCR", async (t) => {
  t.mock.method(tesseract, "createWorker", () =>
    assert.fail("unnecessary OCR"),
  );
  const result = await extractText(buildPdf([["Keep these words."], []]), {
    filename: "text.pdf",
  });
  assert.equal(result.ocr, false);
  assert.match(result.text, /Keep these words/);
});

test("OCR initialization errors are surfaced", async (t) => {
  t.mock.method(tesseract, "createWorker", async () => {
    throw new Error("OCR model unavailable");
  });
  await assert.rejects(
    extractText(imagePdf(), { filename: "scan.pdf" }),
    /OCR model unavailable/,
  );
});

test("Tesseract error callbacks cannot leave uploads waiting indefinitely", async (t) => {
  t.mock.method(tesseract, "createWorker", async (lang, mode, options) => {
    queueMicrotask(() => options.errorHandler("Model download failed"));
    return new Promise(() => {});
  });
  await assert.rejects(
    extractText(imagePdf(), { filename: "scan.pdf" }),
    /Model download failed/,
  );
});

test("empty PDFs return a useful error without OCR downloads", async (t) => {
  t.mock.method(tesseract, "createWorker", () =>
    assert.fail("unnecessary OCR"),
  );
  await assert.rejects(
    extractText(buildPdf([[]]), { filename: "empty.pdf" }),
    /no readable text/,
  );
});
