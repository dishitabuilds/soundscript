const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { requireAuth } = require("../lib/auth");
const models = require("../lib/rag/models");
const answers = require("../lib/rag/answer");
const { buildPassages } = require("../lib/rag/passages");
const { extractText } = require("../lib/extract");

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use((req, res, next) => {
  if (process.env.RAG_ENABLED !== "true")
    return res.status(503).json({
      error: "The study assistant is not available yet.",
      code: "RAG_DISABLED",
    });
  next();
});
router.use(
  rateLimit({
    windowMs: 60000,
    limit: 15,
    keyGenerator: (req) => req.user.id,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);
router.use(async (req, res, next) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      req.params.id,
    )
  )
    return res.status(400).json({ error: "Invalid document ID." });
  try {
    const { data, error } = await req.supabase
      .from("documents")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Document not found." });
    req.document = data;
    next();
  } catch {
    res.status(503).json({ error: "Document search storage is unavailable." });
  }
});

async function loadPassages(req) {
  const passages = [];
  for (let offset = 0; offset <= 2000; offset += 500) {
    const { data, error } = await req.supabase
      .from("document_passages")
      .select(
        "id, text, paragraph_idx, part_idx, audio_chunk_idx, embedding_model",
      )
      .eq("document_id", req.params.id)
      .eq("user_id", req.user.id)
      .order("paragraph_idx")
      .order("part_idx")
      .range(offset, offset + 499);
    if (error)
      throw new models.RagError(
        "Document search is unavailable. Please try again later.",
      );
    passages.push(...data);
    if (passages.length > 2000)
      throw new models.RagError(
        "This document is too large for the study assistant.",
        413,
      );
    if (data.length < 500) break;
  }
  return passages;
}

function failure(res, error) {
  res.status(error instanceof models.RagError ? error.status : 503).json({
    error:
      error instanceof models.RagError
        ? error.message
        : "Document search is unavailable. Please try again.",
  });
}

router.get("/", async (req, res) => {
  try {
    const passages = await loadPassages(req);
    const indexed = passages.filter((p) => p.embedding_model).length;
    res.json({
      passages: passages.length,
      indexed,
      ready: passages.length > 0 && indexed === passages.length,
      generation: Boolean(
        process.env.OPENAI_API_KEY && process.env.RAG_ANSWER_MODEL,
      ),
      reranking: Boolean(process.env.RAG_MODEL_URL),
    });
  } catch (error) {
    failure(res, error);
  }
});

router.post(
  "/index",
  rateLimit({
    windowMs: 60000,
    limit: 2,
    keyGenerator: (req) => req.user.id,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
  async (req, res) => {
    try {
      let passages = await loadPassages(req);
      // Old uploads can recover canonical text from their original private file.
      if (!passages.length && req.document.source_path) {
        const { data: file, error } = await req.supabase.storage
          .from("library")
          .download(req.document.source_path);
        if (error || !file)
          throw new models.RagError(
            "The original upload could not be read. Please upload it again.",
          );
        const source = await extractText(
          Buffer.from(await file.arrayBuffer()),
          { filename: `source.${req.document.source_type}` },
        );
        const rows = buildPassages(source.text, "", []).map((p) => ({
          ...p,
          user_id: req.user.id,
          document_id: req.params.id,
        }));
        const saved = await req.supabase
          .from("document_passages")
          .upsert(rows, {
            onConflict: "document_id,paragraph_idx,part_idx",
            ignoreDuplicates: true,
          });
        if (saved.error) throw saved.error;
        passages = await loadPassages(req);
      }
      if (!passages.length)
        throw new models.RagError(
          "Source passages are missing. Please upload this document again.",
          409,
        );
      let model;
      for (let i = 0; i < passages.length; i += 32) {
        const batch = passages.slice(i, i + 32);
        const result = await models.embed(batch.map((p) => p.text));
        if (model && model !== result.model)
          throw new models.RagError(
            "The embedding model changed during indexing. Please retry.",
          );
        model = result.model;
        const saved = await req.supabase.from("document_passages").upsert(
          batch.map((p, j) => ({
            ...p,
            document_id: req.params.id,
            user_id: req.user.id,
            embedding: result.embeddings[j],
            embedding_model: model,
          })),
          { onConflict: "id" },
        );
        if (saved.error) throw saved.error;
      }
      res.json({ indexed: passages.length, model });
    } catch (error) {
      failure(res, error);
    }
  },
);

router.post("/ask", async (req, res) => {
  try {
    const {
      question,
      mode = "hybrid",
      rerank = true,
      generate = true,
    } = req.body || {};
    if (
      typeof question !== "string" ||
      question.trim().length < 3 ||
      question.length > 1000 ||
      !["keyword", "semantic", "hybrid"].includes(mode) ||
      typeof rerank !== "boolean" ||
      typeof generate !== "boolean"
    )
      return res.status(400).json({
        error:
          "Ask a question of 3–1000 characters and choose a valid search mode.",
      });
    const started = Date.now();
    let vector = null,
      model = null;
    if (mode !== "keyword") {
      const embedded = await models.embed([question.trim()]);
      vector = embedded.embeddings[0];
      model = embedded.model;
      const passages = await loadPassages(req);
      if (!passages.length || passages.some((p) => p.embedding_model !== model))
        throw new models.RagError(
          "Prepare document search before asking questions.",
          409,
        );
    }
    const result = await req.supabase.rpc("search_document_passages", {
      p_document_id: req.params.id,
      p_query: question.trim(),
      p_embedding: vector,
      p_model: model,
      p_mode: mode,
      p_limit: 20,
    });
    if (result.error) throw result.error;
    let passages = result.data || [];
    let reranker = null;
    if (rerank && passages.length) {
      const ranked = await models.rerank(question.trim(), passages);
      passages = ranked.passages;
      reranker = ranked.model;
    }
    passages = passages.slice(0, 5);
    const answer = passages.length
      ? generate
        ? await answers.generateAnswer(question.trim(), passages)
        : {
            mode: "sources",
            answerable: null,
            answer: "Retrieved source passages.",
            citationIds: passages.map((p) => p.id),
          }
      : {
          mode: "sources",
          answerable: false,
          answer: "No matching passages were found. Try a different question.",
          citationIds: [],
        };
    const asset = await req.supabase
      .from("audio_assets")
      .select("timeline")
      .eq("document_id", req.params.id)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (asset.error) throw asset.error;
    const citations = passages
      .filter((p) => answer.citationIds.includes(p.id))
      .map((p) => ({
        id: p.id,
        label: `S${passages.findIndex((candidate) => candidate.id === p.id) + 1}`,
        text: p.text,
        paragraph: p.paragraph_idx + 1,
        startSeconds:
          asset.data?.timeline?.find((t) => t.idx === p.audio_chunk_idx)
            ?.startSeconds ?? null,
      }));
    res.json({
      ...answer,
      citations,
      retrieval: {
        mode,
        embeddingModel: model,
        reranker,
        passageIds: passages.map((p) => p.id),
        ms: Date.now() - started,
      },
    });
  } catch (error) {
    failure(res, error);
  }
});

module.exports = { router };
