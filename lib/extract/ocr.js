// OCR fallback for scanned PDFs.
//
// A scanned page is an image; pdfjs finds no text on it. The fallback renders
// each page to a bitmap and runs Tesseract over it.
//
// tesseract.js is the optional piece: it downloads ~10MB of trained data on
// first use and only earns its keep on scanned documents, so it is an
// optionalDependency and OCR reports itself unavailable when it is absent.
// @napi-rs/canvas is NOT optional -- pdfjs needs it for DOMMatrix during plain
// text extraction, so it is a regular dependency and always present here.

// Render scale: 2x sharpens small print enough for recognition without making
// a page image so large that Tesseract crawls.
const RENDER_SCALE = Number(process.env.OCR_RENDER_SCALE || 2);
const OCR_LANG = process.env.OCR_LANG || "eng";

let deps = null; // null = not probed, false = unavailable
function loadDeps() {
  if (deps !== null) return deps;
  try {
    deps = {
      canvas: require("@napi-rs/canvas"),
      tesseract: require("tesseract.js"),
    };
  } catch (_) {
    deps = false;
  }
  return deps;
}

function ocrAvailable() {
  return Boolean(loadDeps());
}

/**
 * OCR every page of a PDF.
 *
 * One Tesseract worker reused across pages: spawning one per page would pay
 * the model load repeatedly, and pages arrive strictly in order anyway.
 *
 * @param {Buffer|Uint8Array} data the PDF
 * @param {{ log?: Function }} [options]
 * @returns {Promise<string[]>} text per page, same shape extractPages returns
 */
async function ocrPdfPages(data, options = {}) {
  const loaded = loadDeps();
  if (!loaded) {
    throw new Error(
      "OCR is not available on this server. Install the optional dependencies " +
        "(npm install tesseract.js @napi-rs/canvas) to read scanned PDFs.",
    );
  }

  const log = options.log || (() => {});
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const task = pdfjs.getDocument({
    data:
      data instanceof Uint8Array && !Buffer.isBuffer(data)
        ? data
        : new Uint8Array(
            data.buffer ?? data,
            data.byteOffset ?? 0,
            data.byteLength ?? data.length,
          ),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });

  const worker = await loaded.tesseract.createWorker(OCR_LANG);

  try {
    const doc = await task.promise;
    const pages = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = loaded.canvas.createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
        }).promise;

        const image = await canvas.encode("png");
        const { data: result } = await worker.recognize(image);
        pages.push(result.text || "");
        log(`ocr: page ${i}/${doc.numPages}`);
      } finally {
        page.cleanup();
      }
    }

    return pages;
  } finally {
    await worker.terminate().catch(() => {});
    await task.destroy();
  }
}

module.exports = { ocrPdfPages, ocrAvailable };
