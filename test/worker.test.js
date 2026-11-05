const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const axios = require("axios");
const { fakeSupabase } = require("./helpers/fake-supabase");
const {
  processDocument,
  processChunk,
  claimJob,
  requeueFailed,
  MAX_ATTEMPTS,
} = require("../lib/worker/pool");
const {
  withWorkDir,
  makeSilence,
  probeDuration,
} = require("../lib/audio/stitch");
const { hashFor } = require("../lib/tts");
const { assembleDocument } = require("../lib/audio/assemble");
const settings = {
  provider: "elevenlabs",
  voiceId: "test-voice",
  modelId: "test-model",
};
const originalKey = process.env.ELEVEN_API_KEY;
process.env.ELEVEN_API_KEY = "test-only-placeholder";
let audio, db;
before(async () => {
  audio = await withWorkDir(async (dir) => {
    const file = path.join(dir, "silence.mp3");
    await makeSilence(0.1, file);
    return fs.readFile(file);
  });
});
after(() => {
  if (originalKey === undefined) delete process.env.ELEVEN_API_KEY;
  else process.env.ELEVEN_API_KEY = originalKey;
});
beforeEach(() => {
  db = fakeSupabase();
  db.tables.documents = [
    {
      id: "doc",
      user_id: "user",
      provider: settings.provider,
      voice_id: settings.voiceId,
      model_id: settings.modelId,
    },
  ];
  db.tables.jobs = [
    { id: "job", document_id: "doc", user_id: "user", status: "queued" },
  ];
  db.tables.chunks = ["First paragraph.", "Second paragraph."].map(
    (text, idx) => ({
      id: "chunk-" + idx,
      document_id: "doc",
      user_id: "user",
      idx,
      text,
      char_count: text.length,
      content_hash: hashFor(text, settings),
      status: "pending",
      attempts: 0,
      paragraph_idx: idx,
      ends_paragraph: true,
    }),
  );
});
const options = {
  userId: "user",
  documentId: "doc",
  jobId: "job",
  concurrency: 2,
};
function mockSpeech(t) {
  return t.mock.method(axios, "post", async () => ({
    data: audio,
    headers: { "content-type": "audio/mpeg" },
  }));
}

test("mock speech flows through queue, private storage and real FFmpeg assembly", async (t) => {
  const post = mockSpeech(t);
  const result = await processDocument(db, options);
  assert.equal(result.status, "succeeded");
  assert.equal(post.mock.callCount(), 2);
  assert.equal(result.asset.chapters.length, 2);
  assert.deepEqual(
    result.asset.timeline.map((c) => c.idx),
    [0, 1],
  );
  assert.ok(result.asset.duration_seconds > 0.8);
  assert.ok(db.objects.has("library/user/books/doc.mp3"));
  await withWorkDir(async (dir) => {
    const file = path.join(dir, "download.mp3");
    await fs.writeFile(file, db.objects.get("library/user/books/doc.mp3"));
    assert.ok((await probeDuration(file)) > 0.8);
  });
  assert.equal(db.tables.jobs[0].status, "succeeded");
});

test("identical concurrent chunks share one synthesis and subsequent runs use cache", async (t) => {
  const post = mockSpeech(t);
  db.tables.chunks[1].text = db.tables.chunks[0].text;
  db.tables.chunks[1].content_hash = db.tables.chunks[0].content_hash;
  await Promise.all(
    db.tables.chunks.map((chunk) =>
      processChunk(db, "user", chunk, () => {}, settings),
    ),
  );
  assert.equal(post.mock.callCount(), 1);
  assert.equal(db.tables.chunks.filter((c) => c.from_cache).length, 1);
  await processChunk(db, "user", db.tables.chunks[0], () => {}, settings);
  assert.equal(post.mock.callCount(), 1);
});

test("cache coalescing never crosses users", async (t) => {
  const post = mockSpeech(t);
  const chunk = db.tables.chunks[0];
  await Promise.all([
    processChunk(db, "user", chunk, () => {}, settings),
    processChunk(
      db,
      "other-user",
      { ...chunk, id: "other" },
      () => {},
      settings,
    ),
  ]);
  assert.equal(post.mock.callCount(), 2);
});

test("two callers racing to claim one job have only one winner", async () => {
  const claimed = await Promise.all([claimJob(db, "job"), claimJob(db, "job")]);
  assert.equal(claimed.filter(Boolean).length, 1);
});

test("document settings lookup failure never synthesizes with default settings", async (t) => {
  const post = mockSpeech(t);
  db.failures.set("documents", "unavailable");
  const result = await processDocument(db, { ...options, skipAssembly: true });
  assert.equal(result.status, "failed");
  assert.equal(post.mock.callCount(), 0);
  assert.match(result.error, /settings/);
});

test("failed progress lookup cannot declare the job successful", async (t) => {
  mockSpeech(t);
  db.failures.set("document_progress", "unavailable");
  const result = await processDocument(db, { ...options, skipAssembly: true });
  assert.equal(result.status, "failed");
});

test("processing chunks left behind cannot declare the job successful", async () => {
  db.tables.chunks.forEach((c) => {
    c.status = "processing";
  });
  const result = await processDocument(db, { ...options, skipAssembly: true });
  assert.equal(result.status, "failed");
  assert.match(result.error, /unfinished/);
});

test("failed cache lookup never spends credits", async (t) => {
  const post = mockSpeech(t);
  db.failures.set("audio_cache", "unavailable");
  await assert.rejects(
    processChunk(db, "user", db.tables.chunks[0], () => {}, settings),
    /Cache lookup failed/,
  );
  assert.equal(post.mock.callCount(), 0);
});

test("storage failure does not populate a successful cache entry", async (t) => {
  mockSpeech(t);
  db.failures.set("upload", "unavailable");
  const result = await processDocument(db, { ...options, skipAssembly: true });
  assert.equal(result.status, "failed");
  assert.equal(db.tables.audio_cache.length, 0);
  assert.ok(db.tables.chunks.every((c) => c.status === "failed"));
});

test("failed chunk state persistence is surfaced instead of counted as success", async (t) => {
  mockSpeech(t);
  db.failures.set("chunks:update", "unavailable");
  await assert.rejects(
    processDocument(db, { ...options, skipAssembly: true }),
    /update chunk/,
  );
  assert.equal(db.tables.jobs[0].status, "failed");
});

test("failed chunks cannot be requeued beyond the attempt budget", async () => {
  db.tables.chunks.forEach((c) => {
    c.status = "failed";
  });
  db.tables.chunks[1].attempts = MAX_ATTEMPTS;
  assert.equal(await requeueFailed(db, "doc"), 1);
  assert.equal(db.tables.chunks[1].status, "failed");
});

test("service workers cannot process a job referencing another user's document", async (t) => {
  const post = mockSpeech(t);
  db.tables.documents[0].user_id = "victim";
  const result = await processDocument(db, { ...options, skipAssembly: true });
  assert.equal(result.status, "failed");
  assert.equal(post.mock.callCount(), 0);
});

test("forged cache paths never reuse another user's audio", async (t) => {
  const post = mockSpeech(t);
  const chunk = db.tables.chunks[0];
  db.tables.audio_cache = [
    {
      user_id: "user",
      content_hash: chunk.content_hash,
      bucket: "library",
      path: "victim/audio/" + chunk.content_hash + ".mp3",
    },
  ];
  await processChunk(db, "user", chunk, () => {}, settings);
  assert.equal(post.mock.callCount(), 1);
  assert.equal(chunk.path, "user/audio/" + chunk.content_hash + ".mp3");
});

test("assembly refuses forged ownership and storage paths before downloading", async (t) => {
  t.mock.method(db.storage, "from", () =>
    assert.fail("must not read private storage"),
  );
  db.tables.chunks.forEach((c) => {
    c.status = "done";
    c.path = "victim/audio/stolen.mp3";
  });
  await assert.rejects(
    assembleDocument(db, { userId: "user", documentId: "doc" }),
    /ownership/,
  );
});

test("path traversal disguised as a content hash is rejected before spending", async (t) => {
  const post = mockSpeech(t);
  const chunk = { ...db.tables.chunks[0], content_hash: "../../victim" };
  await assert.rejects(
    processChunk(db, "user", chunk, () => {}, settings),
    /content hash/,
  );
  assert.equal(post.mock.callCount(), 0);
});
