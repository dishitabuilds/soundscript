# Local smoke experiment — 4 November 2026

One CPU epoch of `cross-encoder/ms-marco-MiniLM-L6-v2`, trained with 48 relevance
pairs and 16 validation pairs. Test source documents were excluded from training
and negative mining. The final dataset hash matches all three saved JSON records.

Both pretrained and fine-tuned rerankers achieved MRR@5 = 0.875 and nDCG@5 =
0.9077 on the four held-out questions. All retrieval variants had Recall@5 = 1.0.
The BM25 baseline had MRR@5 = 0.6875. **Fine-tuning produced no ranking improvement
on this tiny test set.** These measurements verify the experiment pipeline and
must not be presented as evidence of real-world quality or generalization.

Reports retain each question's retrieved IDs for inspection. The checkpoint is
local at `ml/models/soundscript-reranker-verified` and is deliberately gitignored;
the training recipe, corpus, manifest, and reports are versionable. The original
`ml/models/soundscript-reranker` is an earlier equivalent smoke run made before
dataset whitespace formatting. Use the verified run for provenance comparisons.

Browser verification used the original smoke checkpoint through the private
Python HTTP service, the real React/Express app, an in-memory Supabase substitute,
and silent synthetic audio. Embeddings, reranking, source display, and citation
playback were observed. Paid answer generation was tested using the real AI SDK
adapter with a fake provider response, not a live billed request. The SQL migration
was independently executed and tested with pgvector in embedded Postgres.

The feature remains disabled in the ordinary environment until the migration and
model service are configured. See `docs/ai-study-assistant.md` for setup and the
next dataset/evaluation work.
