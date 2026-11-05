// A real image-only page followed by an optional text page, generated in memory.
const { createCanvas } = require("@napi-rs/canvas");
function imagePdf({ mixed = false } = {}) {
  const canvas = createCanvas(600, 200);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 600, 200);
  context.fillStyle = "black";
  context.font = "36px Arial";
  context.fillText("SOUNDSCRIPT OCR CHECK", 30, 100);
  const jpeg = canvas.toBuffer("image/jpeg");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(
      "<< /Type /Pages /Kids [3 0 R " +
        (mixed ? "7 0 R" : "") +
        "] /Count " +
        (mixed ? "2" : "1") +
        " >>",
    ),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  function stream(content, dictionary = "") {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return Buffer.concat([
      Buffer.from(
        "<< " + dictionary + " /Length " + data.length + " >>\nstream\n",
      ),
      data,
      Buffer.from("\nendstream"),
    ]);
  }
  objects.push(stream("q 600 0 0 200 0 0 cm /Im Do Q"));
  objects.push(
    stream(
      jpeg,
      "/Type /XObject /Subtype /Image /Width 600 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
    ),
  );
  objects.push(
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  );
  if (mixed) {
    objects.push(
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R >>",
      ),
    );
    objects.push(stream("BT /F1 18 Tf 30 100 Td (TEXT PAGE STAYS.) Tj ET"));
  }
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let offset = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(offset);
    const part = Buffer.concat([
      Buffer.from(i + 1 + " 0 obj\n"),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    offset += part.length;
  });
  const xref = offset;
  parts.push(
    Buffer.from(
      "xref\n0 " +
        offsets.length +
        "\n0000000000 65535 f \n" +
        offsets
          .slice(1)
          .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
          .join("") +
        "trailer\n<< /Size " +
        offsets.length +
        " /Root 1 0 R >>\nstartxref\n" +
        xref +
        "\n%%EOF\n",
    ),
  );
  return Buffer.concat(parts);
}
module.exports = { imagePdf };
