// Exercises POST /api/documents against a running server and the real database.
//
// Requires: npm start in another terminal.

require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const { createClient } = require("@supabase/supabase-js");
const { buildPdf } = require("../test/helpers/make-pdf");
const { contentHash } = require("../lib/tts");
const { cleanPages } = require("../lib/text/clean");
const { chunkText } = require("../lib/text/chunker");
const { extractPages } = require("../lib/pdf/extract");

const API = process.env.API_URL || "http://localhost:5000";
const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};

const PAGES = [
  [
    "Introduction to Algorithms",
    "A binary search tree is a data structure that",
    "keeps its keys in sorted order. Lookup is loga-",
    "rithmic in the height of the tree, which",
    "1",
  ],
  [
    "Introduction to Algorithms",
    "matters enormously for large inputs. Balancing",
    "keeps that height small.",
    "",
    "Dr. Knuth discusses this at length in Vol. 3.",
    "2",
  ],
  [
    "Introduction to Algorithms",
    "Traversal visits every node exactly once.",
    "There are three classic orders.",
    "3",
  ],
];

async function upload(jwt, pdf, title) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([pdf], { type: "application/pdf" }),
    "chapter.pdf",
  );
  form.append("title", title);

  const res = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Origin: "http://localhost:5173",
    },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authErr } = await client.auth.signInAnonymously();
  if (authErr) throw new Error(`sign-in failed: ${authErr.message}`);

  const jwt = auth.session.access_token;
  const userId = auth.user.id;
  console.log(`Guest: ${userId}\n`);

  const pdf = buildPdf(PAGES);

  // --- upload --------------------------------------------------------------
  console.log("POST /api/documents (PDF)");
  const first = await upload(jwt, pdf, "Algorithms Ch. 1");

  if (first.status !== 201) {
    return fail(
      `expected 201, got ${first.status}: ${JSON.stringify(first.body)}`,
    );
  }
  pass(`created document ${first.body.document.id}`);
  console.log(`        chunks: ${JSON.stringify(first.body.chunks)}`);
  console.log(`        billable chars: ${first.body.billableChars}`);

  if (first.body.chunks.total > 0)
    pass(`chunked into ${first.body.chunks.total} pieces`);
  else fail("no chunks produced");

  if (first.body.job.status === "queued") pass("job queued");
  else fail(`expected queued job, got ${first.body.job.status}`);

  const docId = first.body.document.id;

  // --- chunk contents ------------------------------------------------------
  console.log("\nchunk rows in the database");
  const { data: chunks } = await client
    .from("chunks")
    .select("idx, text, status, from_cache, content_hash")
    .eq("document_id", docId)
    .order("idx");

  if (!chunks?.length) return fail("no chunk rows found");
  pass(`${chunks.length} rows, all status=${chunks[0].status}`);

  const joined = chunks.map((c) => c.text).join(" ");
  if (!/Introduction to Algorithms/.test(joined))
    pass("running header stripped");
  else fail("header leaked into chunks");

  if (/logarithmic/.test(joined))
    pass("de-hyphenation survived the round trip");
  else fail(`de-hyphenation lost: ${joined}`);

  if (/which matters enormously/.test(joined))
    pass("page-break sentence rejoined");
  else fail("sentence broken at page boundary");

  // --- GET list ------------------------------------------------------------
  console.log("\nGET /api/documents");
  const listRes = await fetch(`${API}/api/documents`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const list = await listRes.json();
  if (list.documents?.some((d) => d.id === docId))
    pass("document appears in the library");
  else fail("document missing from library");

  // --- GET one + progress --------------------------------------------------
  console.log("\nGET /api/documents/:id");
  const oneRes = await fetch(`${API}/api/documents/${docId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const one = await oneRes.json();
  console.log(`        progress: ${JSON.stringify(one.progress)}`);
  if (Number(one.progress.total) === chunks.length)
    pass("progress total matches chunk count");
  else fail(`progress total ${one.progress.total} != ${chunks.length}`);
  if (one.job?.status === "queued") pass("latest job reported");
  else fail("job not reported");

  // --- cache path ----------------------------------------------------------
  // The worker does not exist yet, so audio_cache is seeded by hand to prove
  // the cache branch of buildChunkRows works.
  console.log("\ncache hit on re-upload");
  const pages = await extractPages(pdf);
  const text = cleanPages(pages);
  const expected = chunkText(text, { maxChars: 2000 });

  const cacheRows = expected.map((c) => ({
    user_id: userId,
    content_hash: contentHash(c.text),
    bucket: "library",
    path: `${userId}/audio/${contentHash(c.text)}.mp3`,
    char_count: c.charCount,
  }));

  const { error: cacheErr } = await client
    .from("audio_cache")
    .upsert(cacheRows);
  if (cacheErr) return fail(`could not seed cache: ${cacheErr.message}`);
  pass(`seeded ${cacheRows.length} cache entries`);

  const second = await upload(jwt, pdf, "Algorithms Ch. 1 again");
  if (second.status !== 201) {
    return fail(
      `re-upload failed: ${second.status} ${JSON.stringify(second.body)}`,
    );
  }
  console.log(`        chunks: ${JSON.stringify(second.body.chunks)}`);

  if (second.body.chunks.cached === second.body.chunks.total) {
    pass(`all ${second.body.chunks.total} chunks served from cache`);
  } else {
    fail(
      `only ${second.body.chunks.cached}/${second.body.chunks.total} cached`,
    );
  }

  if (second.body.billableChars === 0) pass("re-upload costs zero characters");
  else fail(`re-upload billed ${second.body.billableChars} chars`);

  // Still queued despite needing no synthesis: the chunks have to be stitched
  // into an audiobook regardless of where their audio came from.
  if (second.body.job.status === "queued") {
    pass("fully-cached document still queues a job (assembly is owed)");
  } else {
    fail(`expected queued job, got ${second.body.job.status}`);
  }

  // --- validation ----------------------------------------------------------
  console.log("\nvalidation");

  const notPdf = new FormData();
  notPdf.append(
    "file",
    new Blob([Buffer.from("hello")], { type: "application/pdf" }),
    "fake.pdf",
  );
  const fakeRes = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: notPdf,
  });
  if (fakeRes.status === 400)
    pass("non-PDF bytes rejected despite PDF mimetype");
  else fail(`expected 400 for fake PDF, got ${fakeRes.status}`);

  const noAuth = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  if (noAuth.status === 401) pass("upload requires auth");
  else fail(`expected 401, got ${noAuth.status}`);

  const emptyText = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "   " }),
  });
  if (emptyText.status === 400) pass("empty text rejected");
  else fail(`expected 400, got ${emptyText.status}`);

  // --- paste path ----------------------------------------------------------
  console.log("\npasted text");
  const pasteRes = await fetch(`${API}/api/documents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "Pasted",
      text: "First paragraph here.\n\nSecond paragraph here.",
    }),
  });
  const paste = await pasteRes.json();
  if (pasteRes.status === 201 && paste.chunks.total === 2) {
    pass("pasted text creates one chunk per paragraph");
  } else {
    fail(`paste failed: ${pasteRes.status} ${JSON.stringify(paste)}`);
  }

  // --- isolation -----------------------------------------------------------
  console.log("\nRLS");
  const other = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: bAuth } = await other.auth.signInAnonymously();
  const bRes = await fetch(`${API}/api/documents/${docId}`, {
    headers: { Authorization: `Bearer ${bAuth.session.access_token}` },
  });
  if (bRes.status === 404) pass("another guest gets 404 for this document");
  else fail(`expected 404 for other user, got ${bRes.status}`);

  // --- cleanup -------------------------------------------------------------
  await fetch(`${API}/api/documents/${docId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const goneRes = await fetch(`${API}/api/documents/${docId}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (goneRes.status === 404) pass("delete removes the document");
  else fail(`document survived delete: ${goneRes.status}`);

  console.log(
    process.exitCode === 1
      ? "\n=== SOME CHECKS FAILED ==="
      : "\n=== ALL CHECKS PASSED ===",
  );
})().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
