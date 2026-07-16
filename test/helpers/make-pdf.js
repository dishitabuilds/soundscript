// Builds a minimal but valid PDF in memory.
//
// Test fixtures for a PDF pipeline have to be actual PDFs, and a committed
// binary is opaque -- nobody can tell what a .pdf in the repo is supposed to
// contain, or change it. Generating them here keeps the fixture readable and
// lets a test declare the exact page layout it needs.

// Text inside a PDF string literal is delimited by parentheses, so those and
// backslashes have to be escaped or the file will not parse.
function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * @param {string[][]} pages lines of text for each page
 * @returns {Buffer} a valid single-font PDF
 */
function buildPdf(pages) {
  const parts = [];
  let offset = 0;
  const offsets = [];

  const push = (s) => {
    const buf = Buffer.from(s, "latin1");
    parts.push(buf);
    offset += buf.length;
  };

  const obj = (num, body) => {
    offsets[num] = offset;
    push(`${num} 0 obj\n${body}\nendobj\n`);
  };

  // 1 catalog, 2 page tree, 3 font, then a page + content stream per page.
  const pageObj = (i) => 4 + i * 2;
  const contentObj = (i) => 5 + i * 2;
  const lastObj = 3 + pages.length * 2;

  push("%PDF-1.4\n");

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(
    2,
    `<< /Type /Pages /Kids [${pages
      .map((_, i) => `${pageObj(i)} 0 R`)
      .join(" ")}] /Count ${pages.length} >>`,
  );
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((lines, i) => {
    obj(
      pageObj(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentObj(i)} 0 R ` +
        `/Resources << /Font << /F1 3 0 R >> >> >>`,
    );

    // TL sets line leading; T* advances one line. Together they make each entry
    // land on its own visual line, which is what pdfjs reports as hasEOL.
    let stream = "BT\n/F1 12 Tf\n72 720 Td\n14 TL\n";
    lines.forEach((line, j) => {
      if (j > 0) stream += "T*\n";
      stream += `(${escapeText(line)}) Tj\n`;
    });
    stream += "ET";

    offsets[contentObj(i)] = offset;
    push(
      `${contentObj(i)} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${lastObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= lastObj; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${lastObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return Buffer.concat(parts);
}

module.exports = { buildPdf };
