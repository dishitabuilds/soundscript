const path = require("path");
const fs = require("fs/promises");

const { stitchChunks, withWorkDir } = require("./stitch");

/**
 * Build the finished audiobook for a document and record it as an asset.
 *
 * Runs after every chunk is done. Downloads each chunk's audio, stitches with
 * pauses, uploads the result, and stores duration and chapter marks.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ userId: string, documentId: string, log?: Function }} options
 */
async function assembleDocument(
  supabase,
  { userId, documentId, log = () => {} },
) {
  const { data: chunks, error } = await supabase
    .from("chunks")
    .select("idx, text, path, status, paragraph_idx, ends_paragraph")
    .eq("document_id", documentId)
    .order("idx");

  if (error) throw new Error(`Could not load chunks: ${error.message}`);
  if (!chunks?.length) throw new Error("Document has no chunks.");

  const unfinished = chunks.filter((c) => c.status !== "done" || !c.path);
  if (unfinished.length) {
    // Assembling now would silently drop the missing pieces and produce an
    // audiobook with holes in it, which is worse than producing nothing.
    throw new Error(
      `${unfinished.length} of ${chunks.length} chunks are not ready; cannot assemble.`,
    );
  }

  return withWorkDir(async (workDir) => {
    log(`downloading ${chunks.length} chunk(s)`);

    // Sequential on purpose: a long document is hundreds of chunks, and firing
    // every download at once would spike memory and hit storage rate limits for
    // no real gain -- the ffmpeg pass afterwards dominates the wall clock.
    const parts = [];
    for (const chunk of chunks) {
      const { data, error: dlError } = await supabase.storage
        .from("library")
        .download(chunk.path);
      if (dlError)
        throw new Error(`Could not download ${chunk.path}: ${dlError.message}`);

      parts.push({
        idx: chunk.idx,
        text: chunk.text,
        paragraphIdx: chunk.paragraph_idx ?? 0,
        endsParagraph: Boolean(chunk.ends_paragraph),
        buffer: Buffer.from(await data.arrayBuffer()),
      });
    }

    const outPath = path.join(workDir, "book.mp3");
    log("stitching");
    const result = await stitchChunks(parts, { outPath, workDir });

    log(
      `stitched: ${result.durationSeconds?.toFixed(1)}s, ` +
        `${result.byteSize} bytes, ${result.chapters.length} chapter(s)`,
    );

    const storagePath = `${userId}/books/${documentId}.mp3`;
    const audio = await fs.readFile(outPath);

    const { error: upError } = await supabase.storage
      .from("library")
      .upload(storagePath, audio, { contentType: "audio/mpeg", upsert: true });

    if (upError)
      throw new Error(`Could not upload audiobook: ${upError.message}`);

    // Replace rather than accumulate: a document has one current audiobook, and
    // re-running should not leave stale assets pointing at overwritten audio.
    await supabase.from("audio_assets").delete().eq("document_id", documentId);

    const { data: asset, error: assetError } = await supabase
      .from("audio_assets")
      .insert({
        document_id: documentId,
        user_id: userId,
        bucket: "library",
        path: storagePath,
        duration_seconds: result.durationSeconds,
        byte_size: result.byteSize,
        chapters: result.chapters,
        // Chunk text is not duplicated here; the read-along view joins this
        // to the chunks table by idx.
        timeline: result.timeline,
      })
      .select()
      .single();

    if (assetError)
      throw new Error(`Could not record asset: ${assetError.message}`);

    return asset;
  });
}

module.exports = { assembleDocument };
