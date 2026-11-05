const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateAnswer } = require("../lib/rag/answer");

// Exercise the installed AI SDK's real provider adapter with a local fake
// response. Never load .env or contact a paid endpoint.
test("structured generation maps short inline citation labels to real evidence IDs", async (t) => {
  process.env.OPENAI_API_KEY = "fixture-key";
  process.env.RAG_ANSWER_MODEL = "fixture-model";
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.RAG_ANSWER_MODEL;
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(String(url).endsWith("/responses"));
    const body = JSON.parse(init.body);
    assert.equal(body.model, "fixture-model");
    assert.ok(JSON.stringify(body).includes("untrusted data"));
    return Response.json({
      id: "resp_fixture",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "fixture-model",
      output: [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                answerable: true,
                answer: "Regularization penalizes complexity [S1].",
                citationIds: ["S1"],
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    });
  });
  const result = await generateAnswer("What is regularization?", [
    { id: "actual-passage-uuid", text: "Regularization penalizes complexity." },
  ]);
  assert.equal(result.mode, "generated");
  assert.deepEqual(result.citationIds, ["actual-passage-uuid"]);
  assert.ok(result.answer.includes("[S1]"));
});
