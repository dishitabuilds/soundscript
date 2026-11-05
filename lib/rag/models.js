class RagError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

async function modelRequest(path, body) {
  const origin = process.env.RAG_MODEL_URL;
  if (!origin)
    throw new RagError("The document search model is not configured yet.");
  try {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.RAG_MODEL_TOKEN
          ? { Authorization: `Bearer ${process.env.RAG_MODEL_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error("model service rejected request");
    return await response.json();
  } catch {
    throw new RagError(
      "The document search model is unavailable. Please try again later.",
    );
  }
}

async function embed(texts) {
  const result = await modelRequest("/embed", { texts });
  if (
    typeof result.model !== "string" ||
    !result.model ||
    !Array.isArray(result.embeddings) ||
    result.embeddings.length !== texts.length ||
    result.embeddings.some(
      (v) =>
        !Array.isArray(v) ||
        v.length !== 384 ||
        v.some((n) => !Number.isFinite(n)),
    )
  ) {
    throw new RagError("The search model returned invalid embeddings.");
  }
  return result;
}

async function rerank(question, passages) {
  const result = await modelRequest("/rerank", {
    question,
    texts: passages.map((p) => p.text),
  });
  if (
    typeof result.model !== "string" ||
    !Array.isArray(result.scores) ||
    result.scores.length !== passages.length ||
    result.scores.some((n) => !Number.isFinite(n))
  ) {
    throw new RagError("The reranker returned invalid scores.");
  }
  return {
    model: result.model,
    passages: passages
      .map((p, i) => ({ ...p, rerank_score: result.scores[i] }))
      .sort((a, b) => b.rerank_score - a.rerank_score),
  };
}

module.exports = { embed, rerank, RagError };
