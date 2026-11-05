import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Substitute only the browser environment and Supabase import, so the real
// API client can run in Node without credentials, Vite or network access.
const adapter = {
  auth: {
    getSession: async () => ({
      data: { session: { access_token: "fixture-token" } },
    }),
  },
  storage: {
    from: () => ({
      createSignedUrl: async () => ({
        data: { signedUrl: "https://storage.invalid/signed" },
        error: null,
      }),
    }),
  },
};
const source = (
  await readFile(new URL("../src/api.js", import.meta.url), "utf8")
)
  .replace(
    'import { supabase } from "./supabase";',
    "const supabase = globalThis.__soundscriptTestClient;",
  )
  .replaceAll(
    "import.meta.env.VITE_BACKEND_URL",
    JSON.stringify("https://api.invalid"),
  );
globalThis.__soundscriptTestClient = adapter;
const api = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);
delete globalThis.__soundscriptTestClient;

test("short conversion sends session authentication and preserves response contract", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.invalid/api/convert");
    assert.equal(init.headers.Authorization, "Bearer fixture-token");
    assert.deepEqual(JSON.parse(init.body), { text: "Hello." });
    return Response.json({
      audioUrl: "https://storage.invalid/audio.mp3",
      cached: true,
    });
  });
  assert.equal((await api.convertText("Hello.")).cached, true);
});

test("API errors reach the UI with their server message", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Daily limit reached." }, { status: 429 }),
  );
  await assert.rejects(api.convertText("Hello."), /Daily limit reached/);
});

test("study questions preserve authentication, options and cancellation", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.invalid/api/documents/doc/rag/ask");
    assert.equal(init.headers.Authorization, "Bearer fixture-token");
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), {
      question: "What is regularization?",
      mode: "hybrid",
    });
    return Response.json({ answer: "A penalty.", citations: [] });
  });
  assert.equal(
    (
      await api.askDocument(
        "doc",
        "What is regularization?",
        { mode: "hybrid" },
        controller.signal,
      )
    ).answer,
    "A penalty.",
  );
});

test("disabled study feature stays hidden while setup failures are visible", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "RAG_DISABLED" }, { status: 503 }),
  );
  assert.equal(await api.getStudyStatus("doc"), null);
  globalThis.fetch = async () =>
    Response.json({ error: "Storage unavailable" }, { status: 503 });
  await assert.rejects(api.getStudyStatus("doc"), /Storage unavailable/);
});

test("an absent browser session never issues an unauthenticated API call", async (t) => {
  t.mock.method(adapter.auth, "getSession", async () => ({
    data: { session: null },
  }));
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected fetch"));
  await assert.rejects(api.listDocuments(), /No active session/);
});

test("upload estimate sends multipart voice settings without overriding its boundary", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.invalid/api/documents");
    assert.equal(init.headers["Content-Type"], undefined);
    assert.equal(init.body.get("estimate"), "1");
    assert.equal(init.body.get("voiceId"), "voice");
    assert.equal(init.body.get("provider"), "elevenlabs");
    assert.equal(await init.body.get("file").text(), "Hello.");
    return Response.json({ estimate: { billableChars: 6 } });
  });
  const file = new File(["Hello."], "sample.txt", { type: "text/plain" });
  const estimate = await api.estimateDocument(file, {
    voice: { provider: "elevenlabs", voiceId: "voice" },
  });
  assert.equal(estimate.billableChars, 6);
});

test("signed downloads request attachment filenames; playback keeps ordinary signed URLs", async (t) => {
  const calls = [];
  t.mock.method(adapter.storage, "from", (bucket) => {
    assert.equal(bucket, "library");
    return {
      createSignedUrl: async (...args) => {
        calls.push(args);
        return {
          data: { signedUrl: "https://storage.invalid/signed" },
          error: null,
        };
      },
    };
  });
  await api.signedUrl("user/book.mp3");
  await api.signedUrl("user/book.mp3", 3600, "My Book.mp3");
  assert.deepEqual(calls[0], ["user/book.mp3", 3600, undefined]);
  assert.deepEqual(calls[1], [
    "user/book.mp3",
    3600,
    { download: "My Book.mp3" },
  ]);
});

test("storage signing failure is reported", async (t) => {
  t.mock.method(adapter.storage, "from", () => ({
    createSignedUrl: async () => ({
      data: null,
      error: { message: "Storage unavailable." },
    }),
  }));
  await assert.rejects(api.signedUrl("book"), /Storage unavailable/);
});

test("position save failures are observable for retry and diagnostics", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Position could not be saved." }, { status: 500 }),
  );
  await assert.rejects(
    api.savePosition("document", 10),
    /Position could not be saved/,
  );
});

test("SSE reader handles split Unicode frames, heartbeats and malformed frames", async (t) => {
  const bytes = new TextEncoder().encode(
    ': ping\n\ndata: {"type":"chunk","text":"café"}\n\ndata: invalid\n\ndata: {"type":"job","status":"succeeded"}\n\n',
  );
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // Split inside é's multi-byte UTF-8 representation as well as JSON frames.
            const split = bytes.indexOf(0xc3) + 1;
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split, split + 7));
            controller.enqueue(bytes.slice(split + 7));
            controller.close();
          },
        }),
      ),
  );
  const events = [];
  await new Promise((resolve, reject) => {
    api.streamDocument(
      "document",
      (event) => {
        events.push(event);
        if (event.type === "job") resolve();
      },
      reject,
    );
  });
  assert.deepEqual(events, [
    { type: "chunk", text: "café" },
    { type: "job", status: "succeeded" },
  ]);
});
