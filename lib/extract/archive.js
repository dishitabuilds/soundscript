const AdmZip = require("adm-zip");

// Bounds apply before any entry is decompressed. adm-zip's patched inflater
// also enforces the declared size, including malicious zero-size headers.
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2048;

function openArchive(data) {
  const zip = new AdmZip(data);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES)
    throw new Error("Archive entry limit exceeded.");
  let total = 0;
  for (const entry of entries) {
    const size = entry.header.size;
    if (size > MAX_ENTRY_BYTES || (total += size) > MAX_TOTAL_BYTES) {
      throw new Error("Archive expanded size limit exceeded.");
    }
    if (entry.header.encrypted)
      throw new Error("Encrypted archives are not supported.");
  }
  return zip;
}

function readArchiveText(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  const data = entry.getData();
  if (data.length > MAX_ENTRY_BYTES || data.length !== entry.header.size) {
    throw new Error("Archive entry has an invalid expanded size.");
  }
  const text = data.toString("utf8");
  if (/<!ENTITY\b/i.test(text)) {
    throw new Error("Archive XML entity declarations are not supported.");
  }
  return text;
}

module.exports = { openArchive, readArchiveText };
