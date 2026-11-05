const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { fakeSupabase } = require("./helpers/fake-supabase");
const clients = require("../lib/supabase");

// Isolated test-process configuration; no .env is loaded or written.
process.env.INLINE_PROCESSING = "false";
process.env.MAX_UPLOAD_BYTES = "1024";
process.env.ELEVEN_API_KEY = "";
process.env.OPENAI_API_KEY = "";
const userId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000002";
let db, server, base;
before(async () => {
  mock.method(clients, "getAuthClient", () => ({
    ...db,
    auth: {
      getUser: async (token) =>
        token === "test-session"
          ? { data: { user: { id: userId } }, error: null }
          : { data: null, error: { message: "invalid token" } },
    },
  }));
  mock.method(clients, "getUserClient", () => db);
  mock.method(clients, "getServiceClient", () => null);
  server = require("../app").listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port;
});
beforeEach(() => {
  db = fakeSupabase();
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mock.restoreAll();
});
function call(
  route,
  { method = "GET", body, token = "test-session", headers = {} } = {},
) {
  return fetch(base + route, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}
function fixture(status = "succeeded") {
  db.tables.documents = [
    { id: documentId, user_id: userId, title: "Sample", source_type: "txt" },
  ];
  db.tables.jobs = [
    { id: "job", document_id: documentId, user_id: userId, status },
  ];
  db.tables.chunks = [
    {
      id: "chunk",
      document_id: documentId,
      user_id: userId,
      idx: 0,
      text: "Sample text.",
      char_count: 12,
      status: "done",
      from_cache: true,
      paragraph_idx: 0,
    },
  ];
}

test("public root, health and database keepalive answer", async () => {
  assert.equal((await call("/")).status, 200);
  const health = await (await call("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.inlineProcessing, false);
  assert.equal((await call("/api/keepalive")).status, 200);
  db.failures.set("documents", "simulated outage");
  assert.equal((await call("/api/keepalive")).status, 503);
});

test("RAG upload preserves canonical text and estimates never create passages", async () => {
  process.env.RAG_ENABLED = "true";
  try {
    db.tables.pronunciation_rules = [{ pattern: "RLS", replacement: "R L S" }];
    const body = { text: "RLS protects rows.\n\nA second paragraph." };
    assert.equal(
      (
        await call("/api/documents", {
          method: "POST",
          body: { ...body, estimate: true },
        })
      ).status,
      200,
    );
    assert.equal(db.tables.document_passages, undefined);
    assert.equal(
      (await call("/api/documents", { method: "POST", body })).status,
      201,
    );
    assert.equal(db.tables.document_passages[0].text, "RLS protects rows.");
    assert.equal(db.tables.chunks[0].text, "R L S protects rows.");
    assert.equal(db.tables.document_passages[1].audio_chunk_idx, 1);
  } finally {
    delete process.env.RAG_ENABLED;
  }
});

const protectedRoutes = [
  ["POST", "/api/convert"],
  ["GET", "/api/documents"],
  ["POST", "/api/documents"],
  ["GET", "/api/documents/" + documentId],
  ["DELETE", "/api/documents/" + documentId],
  ["GET", "/api/documents/" + documentId + "/text"],
  ["GET", "/api/documents/" + documentId + "/events"],
  ["PUT", "/api/documents/" + documentId + "/position"],
  ["POST", "/api/documents/" + documentId + "/process"],
  ["GET", "/api/voices"],
  ["POST", "/api/voices/preview"],
  ["GET", "/api/pronunciations"],
  ["POST", "/api/pronunciations"],
  ["DELETE", "/api/pronunciations/rule"],
  ["GET", "/api/feed"],
  ["POST", "/api/feed/rotate"],
];
for (const [method, route] of protectedRoutes) {
  test(
    method + " " + route + " rejects missing and invalid authentication",
    async () => {
      assert.equal((await call(route, { method, token: "" })).status, 401);
      assert.equal(
        (await call(route, { method, token: "invalid" })).status,
        401,
      );
    },
  );
}

test("malformed, array and oversized JSON return client errors", async () => {
  for (const body of ["{", "[]", "null"]) {
    assert.equal(
      (await call("/api/documents", { method: "POST", body })).status,
      400,
    );
  }
  assert.equal(
    (
      await call("/api/documents", {
        method: "POST",
        body: { text: "x".repeat(1024 * 1024) },
      })
    ).status,
    413,
  );
});

test("CORS accepts the configured local origin and rejects other origins", async () => {
  assert.equal(
    (await call("/", { headers: { Origin: "http://localhost:5173" } })).status,
    200,
  );
  assert.equal(
    (await call("/", { headers: { Origin: "https://untrusted.invalid" } }))
      .status,
    403,
  );
});

test("short conversions validate text before provider requests", async () => {
  for (const text of ["", {}, "x".repeat(501)]) {
    assert.equal(
      (await call("/api/convert", { method: "POST", body: { text } })).status,
      400,
    );
  }
});

test("document estimate is read-only; create queues work and preserves contracts", async () => {
  const input = { text: "Hello world.", title: "Book", estimate: true };
  const quote = await call("/api/documents", { method: "POST", body: input });
  assert.equal(quote.status, 200);
  assert.equal((await quote.json()).estimate.billableChars, 12);
  assert.equal(db.tables.documents?.length || 0, 0);
  const created = await call("/api/documents", {
    method: "POST",
    body: { ...input, estimate: false },
  });
  assert.equal(created.status, 201);
  const data = await created.json();
  assert.equal(data.job.status, "queued");
  assert.equal(db.tables.chunks.length, 1);
});

test("invalid document fields, providers and empty text return 400", async () => {
  for (const body of [
    { text: " " },
    { text: "Text.", title: {} },
    { text: "Text.", provider: "constructor" },
    { text: "Text.", voiceId: {} },
  ]) {
    assert.equal(
      (await call("/api/documents", { method: "POST", body })).status,
      400,
    );
  }
});

test("multipart TXT upload, unsupported extensions and size limits", async () => {
  async function upload(filename, body) {
    const form = new FormData();
    form.append("file", new Blob([body]), filename);
    form.append("estimate", "1");
    return fetch(base + "/api/documents", {
      method: "POST",
      headers: { Authorization: "Bearer test-session" },
      body: form,
    });
  }
  assert.equal((await upload("short.txt", "Hi")).status, 200);
  assert.equal((await upload("bad.exe", "fake")).status, 415);
  assert.equal((await upload("large.txt", "x".repeat(1025))).status, 413);
  assert.equal(
    (await upload("binary.txt", new Uint8Array([0, 1, 2, 3]))).status,
    400,
  );
});

test("library, detail, text, progress SSE, position and deletion work", async () => {
  fixture();
  assert.equal(
    (await (await call("/api/documents")).json()).documents.length,
    1,
  );
  assert.equal(
    (await (await call("/api/documents/" + documentId)).json()).document.title,
    "Sample",
  );
  assert.equal(
    (await (await call("/api/documents/" + documentId + "/text")).json()).chunks
      .length,
    1,
  );
  const events = await call("/api/documents/" + documentId + "/events");
  assert.equal(events.status, 200);
  const stream = await events.text();
  assert.match(stream, /snapshot/);
  assert.match(stream, /succeeded/);
  assert.equal(
    (
      await call("/api/documents/" + documentId + "/position", {
        method: "PUT",
        body: { seconds: 12.5 },
      })
    ).status,
    204,
  );
  assert.equal(db.tables.listening_positions[0].position_seconds, 12.5);
  for (const seconds of [null, "", -1, "12"]) {
    assert.equal(
      (
        await call("/api/documents/" + documentId + "/position", {
          method: "PUT",
          body: { seconds },
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await call("/api/documents/" + documentId, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await call("/api/documents/" + documentId)).status, 404);
});

test("active document processing returns conflict; unknown document returns 404", async () => {
  fixture("running");
  assert.equal(
    (
      await call("/api/documents/" + documentId + "/process", {
        method: "POST",
      })
    ).status,
    409,
  );
  db.tables.jobs = [];
  db.tables.chunks[0].status = "pending";
  assert.equal(
    (
      await call("/api/documents/" + documentId + "/process", {
        method: "POST",
      })
    ).status,
    202,
  );
  assert.equal(
    (await call("/api/documents/missing/process", { method: "POST" })).status,
    404,
  );
});

test("pronunciation CRUD and validation", async () => {
  const created = await call("/api/pronunciations", {
    method: "POST",
    body: { pattern: "TTS", replacement: "text to speech" },
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).rule.id;
  assert.equal(
    (await (await call("/api/pronunciations")).json()).rules.length,
    1,
  );
  assert.equal(
    (
      await call("/api/pronunciations", {
        method: "POST",
        body: { pattern: "" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("/api/pronunciations/" + id, { method: "DELETE" })).status,
    204,
  );
});

test("voices degrade without credentials; previews fail safely without speech", async () => {
  assert.equal((await call("/api/voices")).status, 200);
  assert.equal(
    (await call("/api/voices/preview", { method: "POST", body: {} })).status,
    400,
  );
});

test("feed management rotates tokens and disabled public feed stays private", async () => {
  const first = await (await call("/api/feed")).json();
  assert.equal(first.enabled, false);
  const rotated = await (
    await call("/api/feed/rotate", { method: "POST" })
  ).json();
  assert.notEqual(first.url, rotated.url);
  assert.equal((await call("/feeds/unknown.xml", { token: "" })).status, 404);
});

test("database errors return failures without generating audio", async () => {
  db.failures.set("audio_cache", "simulated database failure");
  assert.equal(
    (await call("/api/documents", { method: "POST", body: { text: "Hello." } }))
      .status,
    500,
  );
  db.failures.clear();
  db.failures.set("documents", "simulated database failure");
  assert.equal((await call("/api/documents")).status, 500);
});
