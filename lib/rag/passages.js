const { chunkText } = require("../text/chunker");

// Citation text is captured BEFORE pronunciation replacements. Audio links are
// paragraph-level, and omitted if a rule changed the paragraph structure.
function buildPassages(sourceText, speechText, speechChunks) {
  const paragraphs = sourceText
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const spoken = speechText.split(/\n\s*\n+/).filter((p) => p.trim());
  const canLink = paragraphs.length === spoken.length;
  return paragraphs.flatMap((text, paragraphIdx) => {
    const audio = canLink
      ? speechChunks.find((c) => c.paragraphIdx === paragraphIdx)
      : null;
    return chunkText(text, { maxChars: 900 }).map((part, partIdx) => ({
      text: part.text,
      paragraph_idx: paragraphIdx,
      part_idx: partIdx,
      audio_chunk_idx: audio?.idx ?? null,
    }));
  });
}

module.exports = { buildPassages };
