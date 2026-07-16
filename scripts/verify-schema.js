// Verifies the pipeline schema against the real remote database:
//   - tables exist and accept writes
//   - concurrent claim_next_chunk never hands the same chunk to two workers
//   - document_progress counts correctly
//   - RLS isolates one guest's documents/chunks from another's
//   - the library bucket is private and per-user

require("dotenv").config({
  path: require("path").join(__dirname, "..", ".env"),
});
const { createClient } = require("@supabase/supabase-js");

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};

async function newGuest(label) {
  const c = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw new Error(`${label} sign-in failed: ${error.message}`);
  return { client: c, id: data.user.id };
}

(async () => {
  const A = await newGuest("A");
  const B = await newGuest("B");
  console.log(`Guest A: ${A.id}`);
  console.log(`Guest B: ${B.id}\n`);

  // --- documents -----------------------------------------------------------
  console.log("documents");
  const { data: doc, error: docErr } = await A.client
    .from("documents")
    .insert({
      user_id: A.id,
      title: "Test Chapter",
      source_type: "paste",
      char_count: 500,
    })
    .select()
    .single();

  if (docErr) return fail(`insert document: ${docErr.message}`);
  pass(`created document ${doc.id}`);

  // --- chunks --------------------------------------------------------------
  console.log("\nchunks");
  const rows = Array.from({ length: 5 }, (_, i) => ({
    document_id: doc.id,
    user_id: A.id,
    idx: i,
    text: `Sentence number ${i}.`,
    char_count: 20,
    content_hash: `hash-${i}`,
  }));

  const { error: chunkErr } = await A.client.from("chunks").insert(rows);
  if (chunkErr) return fail(`insert chunks: ${chunkErr.message}`);
  pass("inserted 5 pending chunks");

  // idx must be unique per document
  const { error: dupErr } = await A.client.from("chunks").insert({
    document_id: doc.id,
    user_id: A.id,
    idx: 0,
    text: "duplicate slot",
    char_count: 5,
    content_hash: "dup",
  });
  if (dupErr) pass("duplicate (document_id, idx) rejected");
  else fail("duplicate (document_id, idx) was allowed");

  // status is constrained
  const { error: statusErr } = await A.client.from("chunks").insert({
    document_id: doc.id,
    user_id: A.id,
    idx: 99,
    text: "bad status",
    char_count: 5,
    content_hash: "bad",
    status: "banana",
  });
  if (statusErr) pass("invalid status rejected by check constraint");
  else fail("invalid status was accepted");

  // --- the important one: concurrent claiming ------------------------------
  console.log("\nclaim_next_chunk under concurrency");
  const claims = await Promise.all(
    Array.from({ length: 5 }, () =>
      A.client.rpc("claim_next_chunk", { p_document_id: doc.id }),
    ),
  );

  const claimed = claims
    .map((r) => (r.data && r.data[0] ? r.data[0].idx : null))
    .filter((v) => v !== null);

  const unique = new Set(claimed);
  console.log(`  claimed idx values: [${claimed.join(", ")}]`);

  if (claimed.length !== unique.size) {
    fail(`same chunk handed out twice -- SKIP LOCKED is not holding`);
  } else {
    pass(
      `${claimed.length} concurrent claims, ${unique.size} distinct chunks, no double-claim`,
    );
  }

  // a 6th claim on an exhausted queue returns nothing rather than erroring
  const { data: empty } = await A.client.rpc("claim_next_chunk", {
    p_document_id: doc.id,
  });
  if (!empty || empty.length === 0)
    pass("claim on exhausted queue returns empty");
  else fail(`claim on exhausted queue returned ${JSON.stringify(empty)}`);

  // attempts incremented
  const { data: afterClaim } = await A.client
    .from("chunks")
    .select("idx, status, attempts")
    .eq("document_id", doc.id)
    .order("idx");
  const allProcessing = afterClaim.every(
    (c) => c.status === "processing" && c.attempts === 1,
  );
  if (allProcessing) pass("claimed chunks are processing with attempts=1");
  else fail(`unexpected state: ${JSON.stringify(afterClaim)}`);

  // --- progress ------------------------------------------------------------
  console.log("\ndocument_progress");
  await A.client
    .from("chunks")
    .update({ status: "done" })
    .eq("document_id", doc.id)
    .in("idx", [0, 1, 2]);
  await A.client
    .from("chunks")
    .update({ status: "failed", last_error: "simulated" })
    .eq("document_id", doc.id)
    .eq("idx", 3);

  const { data: prog } = await A.client.rpc("document_progress", {
    p_document_id: doc.id,
  });
  const p = Array.isArray(prog) ? prog[0] : prog;
  console.log(`  ${JSON.stringify(p)}`);
  if (p.total === 5 && p.done === 3 && p.failed === 1 && p.processing === 1) {
    pass("counts are correct (5 total, 3 done, 1 failed, 1 processing)");
  } else {
    fail("counts are wrong");
  }

  // --- updated_at trigger --------------------------------------------------
  console.log("\nupdated_at trigger");
  const { data: touched } = await A.client
    .from("chunks")
    .select("created_at, updated_at")
    .eq("document_id", doc.id)
    .eq("idx", 0)
    .single();
  if (new Date(touched.updated_at) > new Date(touched.created_at)) {
    pass("updated_at advanced past created_at on update");
  } else {
    fail(
      `updated_at (${touched.updated_at}) did not advance past created_at (${touched.created_at})`,
    );
  }

  // --- RLS isolation -------------------------------------------------------
  console.log("\nRLS isolation (guest B vs guest A's data)");
  const { data: bDocs } = await B.client.from("documents").select("*");
  if (!bDocs || bDocs.length === 0) pass("B cannot see A's documents");
  else fail(`B saw ${bDocs.length} of A's documents`);

  const { data: bChunks } = await B.client.from("chunks").select("*");
  if (!bChunks || bChunks.length === 0) pass("B cannot see A's chunks");
  else fail(`B saw ${bChunks.length} of A's chunks`);

  // B tries to claim A's work by passing A's document id directly
  const { data: stolen } = await B.client.rpc("claim_next_chunk", {
    p_document_id: doc.id,
  });
  if (!stolen || stolen.length === 0) pass("B cannot claim A's chunks via RPC");
  else fail(`B claimed A's chunk: ${JSON.stringify(stolen)}`);

  // B tries to write a chunk into A's document
  const { error: forgeErr } = await B.client.from("chunks").insert({
    document_id: doc.id,
    user_id: A.id,
    idx: 42,
    text: "forged",
    char_count: 6,
    content_hash: "forged",
  });
  if (forgeErr) pass("B cannot insert chunks attributed to A");
  else fail("B inserted a chunk into A's document");

  // --- storage -------------------------------------------------------------
  console.log("\nlibrary bucket");
  const body = Buffer.from("fake audio");
  const { error: upErr } = await A.client.storage
    .from("library")
    .upload(`${A.id}/audio/test.mp3`, body, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (!upErr) pass("A can write to their own folder");
  else fail(`A could not write to their own folder: ${upErr.message}`);

  const { error: crossErr } = await B.client.storage
    .from("library")
    .upload(`${A.id}/audio/evil.mp3`, body, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (crossErr) pass("B cannot write into A's folder");
  else fail("B wrote into A's folder");

  // bucket must be private: the public URL should not serve the object
  const pub = A.client.storage
    .from("library")
    .getPublicUrl(`${A.id}/audio/test.mp3`);
  const res = await fetch(pub.data.publicUrl);
  if (!res.ok) pass(`bucket is private (public URL -> HTTP ${res.status})`);
  else
    fail("bucket is public -- private documents would be readable by anyone");

  // signed URL is the intended access path
  const { data: signed, error: signErr } = await A.client.storage
    .from("library")
    .createSignedUrl(`${A.id}/audio/test.mp3`, 60);
  if (signErr) {
    fail(`could not sign URL: ${signErr.message}`);
  } else {
    const sres = await fetch(signed.signedUrl);
    if (sres.ok) pass(`signed URL serves the object (HTTP ${sres.status})`);
    else fail(`signed URL failed: HTTP ${sres.status}`);
  }

  // --- cascade -------------------------------------------------------------
  console.log("\ncascade");
  await A.client.from("documents").delete().eq("id", doc.id);
  const { data: orphans } = await A.client
    .from("chunks")
    .select("id")
    .eq("document_id", doc.id);
  if (!orphans || orphans.length === 0)
    pass("deleting a document cascades its chunks");
  else fail(`${orphans.length} chunks orphaned after document delete`);

  // cleanup
  await A.client.storage.from("library").remove([`${A.id}/audio/test.mp3`]);

  console.log(
    process.exitCode === 1
      ? "\n=== SOME CHECKS FAILED ==="
      : "\n=== ALL CHECKS PASSED ===",
  );
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
