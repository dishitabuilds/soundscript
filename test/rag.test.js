const { test, before, beforeEach, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { fakeSupabase } = require("./helpers/fake-supabase");
const clients = require("../lib/supabase");
const models = require("../lib/rag/models");
const answers = require("../lib/rag/answer");
const { buildPassages } = require("../lib/rag/passages");
const { chunkText } = require("../lib/text/chunker");
const userId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000002";
let db, server, base, calls;
process.env.RAG_ENABLED = "true";
process.env.INLINE_PROCESSING = "false";
process.env.OPENAI_API_KEY = "";
before(async () => {
  mock.method(clients, "getAuthClient", () => ({
    auth: {
      getUser: async (token) =>
        token === "session"
          ? { data: { user: { id: userId } } }
          : { error: { message: "invalid" } },
    },
  }));
  mock.method(clients, "getUserClient", () => db);
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/api/documents/:id/rag", require("../routes/rag").router);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api/documents/${documentId}/rag`;
});
beforeEach(() => {
  db = fakeSupabase();
  calls = [];
  db.tables.documents = [{ id: documentId, user_id: userId }];
  db.tables.document_passages = [
    {
      id: "p1",
      document_id: documentId,
      user_id: userId,
      text: "Regularization penalizes complexity.",
      paragraph_idx: 0,
      part_idx: 0,
      audio_chunk_idx: 0,
      embedding_model: "model",
    },
    {
      id: "p2",
      document_id: documentId,
      user_id: userId,
      text: "Learning rate controls optimizer steps.",
      paragraph_idx: 1,
      part_idx: 0,
      audio_chunk_idx: 1,
      embedding_model: "model",
    },
  ];
  db.tables.audio_assets = [
    {
      document_id: documentId,
      user_id: userId,
      timeline: [
        { idx: 0, startSeconds: 0 },
        { idx: 1, startSeconds: 12 },
      ],
    },
  ];
  db.rpc = async (name, args) => {
    calls.push({ name, args });
    return { data: db.tables.document_passages, error: null };
  };
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mock.restoreAll();
});
function call(path = "", body, token = "session") {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("canonical evidence survives pronunciation changes and links paragraphs to audio", () => {
  const rows = buildPassages(
    "RLS protects rows.\n\nAnother paragraph.",
    "R L S protects rows.\n\nAnother paragraph.",
    chunkText("R L S protects rows.\n\nAnother paragraph."),
  );
  assert.equal(rows[0].text, "RLS protects rows.");
  assert.equal(rows[1].audio_chunk_idx, 1);
  assert.equal(
    buildPassages("One paragraph.", "One\n\nparagraph.", [])[0].audio_chunk_idx,
    null,
  );
});
test("answer validator rejects fabricated citations and uncited answers", () => {
  const passages = [{ id: "p1" }];
  assert.throws(() =>
    answers.validateAnswer(
      { answer: "A claim", answerable: true, citationIds: ["unknown"] },
      passages,
    ),
  );
  assert.throws(() =>
    answers.validateAnswer(
      { answer: "A claim", answerable: true, citationIds: [] },
      passages,
    ),
  );
  assert.equal(
    answers.validateAnswer(
      { answer: "Outside knowledge", answerable: false, citationIds: [] },
      passages,
    ).answerable,
    false,
  );
});
test("authentication and explicit owner filters prevent access before model calls", async () => {
  assert.equal((await call("", undefined, "")).status, 401);
  db.tables.documents[0].user_id = "another-user";
  assert.equal((await call()).status, 404);
  assert.equal((await call("/ask", { question: "What is RLS?" })).status, 404);
  assert.equal(calls.length, 0);
});
test("keyword search needs no model service and returns audio evidence", async () => {
  const response = await call("/ask", {
    question: "What is regularization?",
    mode: "keyword",
    rerank: false,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "sources");
  assert.equal(result.answerable, null);
  assert.equal(result.citations[0].startSeconds, 0);
  assert.equal(result.citations[1].startSeconds, 12);
  assert.equal(calls[0].args.p_embedding, null);
});
test("semantic retrieval rejects incomplete or incompatible indexes", async (t) => {
  t.mock.method(models, "embed", async () => ({
    model: "different-model",
    embeddings: [Array(384).fill(0.1)],
  }));
  const response = await call("/ask", {
    question: "Explain regularization",
    mode: "hybrid",
  });
  assert.equal(response.status, 409);
  assert.equal(calls.length, 0);
});
test("hybrid retrieval reranks before selecting citations", async (t) => {
  t.mock.method(models, "embed", async () => ({
    model: "model",
    embeddings: [Array(384).fill(0.1)],
  }));
  t.mock.method(models, "rerank", async (question, passages) => ({
    model: "trained-reranker",
    passages: [...passages].reverse(),
  }));
  t.mock.method(answers, "generateAnswer", async () => ({
    mode: "generated",
    answerable: true,
    answer: "Optimizer steps [p2].",
    citationIds: ["p2"],
  }));
  const response = await call("/ask", {
    question: "What controls optimizer steps?",
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.retrieval.reranker, "trained-reranker");
  assert.deepEqual(
    result.citations.map((c) => c.id),
    ["p2"],
  );
  assert.equal(result.citations[0].startSeconds, 12);
  assert.equal(calls[0].args.p_document_id, documentId);
});
test("indexing writes validated model vectors to source passages", async (t) => {
  t.mock.method(models, "embed", async (texts) => ({
    model: "model",
    embeddings: texts.map(() => Array(384).fill(0.1)),
  }));
  assert.equal((await call("/index", {})).status, 200);
  assert.equal(db.tables.document_passages[0].embedding.length, 384);
});
test("input validation rejects unsupported retrieval modes and malformed questions", async () => {
  for (const body of [
    { question: "x" },
    { question: {} },
    { question: "A valid question", mode: "invalid" },
  ]) {
    assert.equal((await call("/ask", body)).status, 400);
  }
});
test("model client rejects wrong dimensions and reranker score counts", async (t) => {
  process.env.RAG_MODEL_URL = "http://127.0.0.1:8001";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ model: "bad", embeddings: [[1]], scores: [] }),
  );
  await assert.rejects(models.embed(["some text"]), /invalid embeddings/);
  await assert.rejects(
    models.rerank("question", [{ text: "some text" }]),
    /invalid scores/,
  );
});
