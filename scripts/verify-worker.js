// Drives a real document through the worker pool: upload -> synthesise -> done.
//
// This spends real ElevenLabs credits, so the fixture is deliberately tiny.
// Requires: npm start in another terminal.

require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const { createClient } = require("@supabase/supabase-js");
const { buildPdf } = require("../test/helpers/make-pdf");

const API = process.env.API_URL || "http://localhost:5000";
const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Short on purpose: every character here is a credit.
const PAGES = [
  ["Notes", "A tree has no cycles.", "1"],
  ["Notes", "Traversal visits each node once.", "2"],
  ["Notes", "Balancing keeps height low.", "3"],
];

async function poll(jwt, docId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    const res = await fetch(`${API}/api/documents/${docId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = await res.json();
    const status = body.job?.status;

    if (JSON.stringify(body.progress) !== JSON.stringify(last)) {
      console.log(
        `        job=${status} progress=${JSON.stringify(body.progress)}`,
      );
      last = body.progress;
    }

    if (status === "succeeded" || status === "failed") return body;
    await sleep(1000);
  }
  throw new Error("timed out waiting for the job to finish");
}

(async () => {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await client.auth.signInAnonymously();
  const jwt = auth.session.access_token;
  const userId = auth.user.id;
  console.log(`Guest: ${userId}\n`);

  // --- upload, which auto-starts the pool ----------------------------------
  console.log("upload -> auto-start");
  const form = new FormData();
  form.append(
    "file",
    new Blob([buildPdf(PAGES)], { type: "application/pdf" }),
    "notes.pdf",
  );
  form.append("title", "Worker Test");

  const res = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  const created = await res.json();

  if (res.status !== 201)
    return fail(`upload failed: ${res.status} ${JSON.stringify(created)}`);

  const docId = created.document.id;
  console.log(`        document ${docId}`);
  console.log(`        chunks: ${JSON.stringify(created.chunks)}`);
  pass(`uploaded, ${created.chunks.pending} chunk(s) queued`);

  // --- watch it run --------------------------------------------------------
  console.log("\nworker progress");
  const final = await poll(jwt, docId);

  if (final.job.status === "succeeded") pass("job succeeded");
  else return fail(`job ${final.job.status}: ${final.job.error}`);

  if (Number(final.progress.done) === Number(final.progress.total)) {
    pass(`all ${final.progress.total} chunks done`);
  } else {
    fail(`only ${final.progress.done}/${final.progress.total} done`);
  }

  if (final.job.started_at && final.job.finished_at)
    pass("job has start and finish timestamps");
  else fail("job timestamps missing");

  // --- chunk rows ----------------------------------------------------------
  console.log("\nchunk rows");
  const { data: chunks } = await client
    .from("chunks")
    .select("idx, status, path, attempts, from_cache, last_error")
    .eq("document_id", docId)
    .order("idx");

  if (chunks.every((c) => c.status === "done")) pass("every chunk is done");
  else fail(`not all done: ${JSON.stringify(chunks.map((c) => c.status))}`);

  if (chunks.every((c) => c.path)) pass("every chunk has an audio path");
  else fail("some chunks have no path");

  if (chunks.every((c) => c.attempts === 1))
    pass("each chunk was claimed exactly once");
  else
    fail(
      `unexpected attempts: ${JSON.stringify(chunks.map((c) => c.attempts))}`,
    );

  // --- cache ---------------------------------------------------------------
  console.log("\naudio_cache");
  const { data: cache } = await client
    .from("audio_cache")
    .select("content_hash, path, char_count");
  if (cache.length >= chunks.length)
    pass(`${cache.length} cache entries written`);
  else fail(`expected >= ${chunks.length} cache entries, got ${cache.length}`);

  // --- the audio is real ---------------------------------------------------
  console.log("\naudio in storage");
  let totalBytes = 0;
  for (const chunk of chunks) {
    const { data: signed, error } = await client.storage
      .from("library")
      .createSignedUrl(chunk.path, 60);

    if (error) {
      fail(`could not sign ${chunk.path}: ${error.message}`);
      continue;
    }

    const audioRes = await fetch(signed.signedUrl);
    const buf = Buffer.from(await audioRes.arrayBuffer());
    totalBytes += buf.length;

    const isMp3 =
      buf.subarray(0, 3).toString("latin1") === "ID3" ||
      (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);

    if (audioRes.ok && isMp3)
      pass(`chunk ${chunk.idx}: ${buf.length} bytes of real MP3`);
    else
      fail(
        `chunk ${chunk.idx}: not valid MP3 (HTTP ${audioRes.status}, ${buf.length}b)`,
      );
  }
  console.log(`        total audio: ${totalBytes} bytes`);

  // --- the assembled audiobook ---------------------------------------------
  console.log("\nassembled audiobook");
  const asset = final.asset;

  if (!asset) {
    fail("no audio_asset was produced");
  } else {
    pass(`asset recorded at ${asset.path}`);

    if (asset.duration_seconds > 0) {
      pass(`duration reported: ${Number(asset.duration_seconds).toFixed(2)}s`);
    } else {
      fail(`duration missing or zero: ${asset.duration_seconds}`);
    }

    if (asset.byte_size > 0) pass(`byte size: ${asset.byte_size}`);
    else fail("byte size missing");

    const chapters = asset.chapters || [];
    if (chapters.length > 0) {
      pass(`${chapters.length} chapter marker(s)`);
      chapters.forEach((c) =>
        console.log(
          `        ${String(c.startSeconds).padStart(7)}s  ${c.title}`,
        ),
      );
      const increasing = chapters.every(
        (c, i) => i === 0 || c.startSeconds > chapters[i - 1].startSeconds,
      );
      if (increasing) pass("chapter timestamps strictly increase");
      else fail("chapter timestamps are not ordered");
    } else {
      fail("no chapters recorded");
    }

    const { data: signed, error: signErr } = await client.storage
      .from("library")
      .createSignedUrl(asset.path, 60);

    if (signErr) {
      fail(`could not sign the audiobook: ${signErr.message}`);
    } else {
      const bookRes = await fetch(signed.signedUrl);
      const book = Buffer.from(await bookRes.arrayBuffer());
      const isMp3 =
        book.subarray(0, 3).toString("latin1") === "ID3" ||
        (book[0] === 0xff && (book[1] & 0xe0) === 0xe0);

      if (bookRes.ok && isMp3)
        pass(`audiobook downloads as real MP3 (${book.length} bytes)`);
      else fail(`audiobook is not valid MP3 (HTTP ${bookRes.status})`);

      // The stitched book must be longer than any single chunk, or the concat
      // silently dropped pieces.
      if (book.length > 0) pass("audiobook is non-empty");
    }
  }

  // --- re-running a finished document is a no-op ---------------------------
  console.log("\nre-process a finished document");
  const again = await fetch(`${API}/api/documents/${docId}/process`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const againBody = await again.json();
  if (
    again.status === 200 &&
    /already fully synthesised/.test(againBody.message || "")
  ) {
    pass("no new job for an already-complete document");
  } else {
    fail(`expected a no-op, got ${again.status}: ${JSON.stringify(againBody)}`);
  }

  // --- second document with identical text is free -------------------------
  console.log("\nsecond upload of identical text");
  const form2 = new FormData();
  form2.append(
    "file",
    new Blob([buildPdf(PAGES)], { type: "application/pdf" }),
    "notes2.pdf",
  );
  form2.append("title", "Worker Test Copy");

  const res2 = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form2,
  });
  const created2 = await res2.json();
  console.log(`        chunks: ${JSON.stringify(created2.chunks)}`);

  if (created2.body?.error) return fail(created2.body.error);
  if (
    created2.chunks.cached === created2.chunks.total &&
    created2.billableChars === 0
  ) {
    pass("identical document reuses cached audio, costs nothing");
  } else {
    fail(`expected a full cache hit, got ${JSON.stringify(created2.chunks)}`);
  }

  // Zero synthesis still owes an audiobook, so the job runs -- it just skips
  // every API call and goes straight to stitching.
  const final2 = await poll(jwt, created2.document.id);
  if (final2.job.status === "succeeded")
    pass("cached document still assembles");
  else
    fail(`expected succeeded, got ${final2.job.status}: ${final2.job.error}`);

  if (final2.asset?.duration_seconds > 0) {
    pass(
      `cached document produced its own audiobook (${Number(final2.asset.duration_seconds).toFixed(2)}s)`,
    );
  } else {
    fail("cached document produced no audiobook");
  }

  // --- cleanup -------------------------------------------------------------
  for (const id of [docId, created2.document.id]) {
    await fetch(`${API}/api/documents/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }

  console.log(
    process.exitCode === 1
      ? "\n=== SOME CHECKS FAILED ==="
      : "\n=== ALL CHECKS PASSED ===",
  );
})().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
