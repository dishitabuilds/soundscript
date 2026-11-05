# SoundScript study assistant

The study assistant searches canonical document passages, optionally reranks them,
and produces source excerpts or a generated answer with citations. Citations can
seek to the first audio chunk of their source paragraph. Retrieval passages and
speech chunks have separate boundaries. References are paragraph numbers, not PDF
page numbers or word-accurate audio positions.

The hand-authored corpus below is for smoke tests. Use the
[larger human-annotated ranking benchmark](reviewed-ranking.md) for model
selection, and [free local speech](free-speech.md) to avoid monthly TTS credits.

## Local setup

1. Apply `supabase/migrations/20261104120000_document_rag.sql` through your usual
   Supabase migration workflow. Enable the feature only after migration succeeds.
2. Create a Python 3.10+ environment and install the tested dependencies:

   ```powershell
   uv venv ml/.venv --python 3.10
   uv pip install --python ml/.venv/Scripts/python.exe -r ml/requirements.txt
   $env:HF_HOME = "$PWD/ml/.cache/huggingface"
   & ml/.venv/Scripts/python.exe -m uvicorn service:app --app-dir ml --host 127.0.0.1 --port 8001
   ```

   First inference downloads two public Apache-2.0 models. The service uses CPU,
   keeps models in memory, and does not store document text. Keep it on a private
   network. For a hosted service, configure `MODEL_SERVICE_TOKEN` on Python and
   the matching `RAG_MODEL_TOKEN` on Node, and use HTTPS between hosts. Do not
   expose an unauthenticated model service through a reverse proxy.

3. Set `RAG_ENABLED=true` and `RAG_MODEL_URL=http://127.0.0.1:8001` in the backend
   environment and restart the API. Existing deployment settings are unchanged
   until you do this. Install Node dependencies with `npm ci`.
4. Upload a document, open it, and use **Prepare meaning-based search**. Ask a
   question. Source search works without a paid generation provider. To synthesize
   answers, configure `OPENAI_API_KEY` and `RAG_ANSWER_MODEL` with a
   structured-output-capable model available to your account. Source mode is
   labeled explicitly and makes no answerability claim.

The backend forwards the caller's JWT to Supabase. RLS and an explicit owner check
apply to retrieval and indexing. The model service never receives database keys.
Embeddings are 384-dimensional and carry an exact model identifier; semantic
search rejects partial or incompatible indexes. Indexing is batched and retryable.
Uploads retain canonical text before pronunciation replacements. Index older
uploads from their original private source file; old pasted documents need to be
uploaded again because their original text was not retained. Backfilled passages
omit audio links rather than infer an unreliable mapping.

## API

- `GET /api/documents/:id/rag`: passage counts and capabilities.
- `POST /api/documents/:id/rag/index`: embed source passages; no speech generation.
- `POST /api/documents/:id/rag/ask`: JSON `question`, `mode` (`keyword`, `semantic`,
  `hybrid`), `rerank` (boolean), `generate` (boolean). Defaults are hybrid search,
  reranking, and generation when configured. Keyword search with `rerank=false`
  works without Python. Responses include citations, retrieval configuration,
  passage IDs, model names, elapsed milliseconds, and optional token usage.

Hybrid retrieval fuses keyword and exact cosine ranks with RRF (`k=60`). Search is
scoped to one document. Initial candidates are reranked before selecting up to
five evidence passages. Model-supplied citations are validated against the actual
context, including inline `[S1]` references. This validation does **not** prove
that an answer is factually supported: review that separately. The prompt treats
uploaded instructions as untrusted data. Rate limits bound requests per user.

## Reproduce evaluation and fine-tuning

Run from the repository root. On Unix use `ml/.venv/bin/python` in these commands.

```powershell
& ml/.venv/Scripts/python.exe -m unittest discover -s ml -p 'test_*.py'
& ml/.venv/Scripts/python.exe ml/evaluate.py --lexical-only
& ml/.venv/Scripts/python.exe ml/evaluate.py --output ml/runs/pretrained-test.json
& ml/.venv/Scripts/python.exe ml/train.py --output ml/models/soundscript-reranker
& ml/.venv/Scripts/python.exe ml/evaluate.py --reranker ml/models/soundscript-reranker --output ml/runs/finetuned-test.json
```

Training uses question/passage relevance pairs, with up to three BM25-mined
negatives per query. Negative mining stays inside the training split; validation
uses its own source documents. Checkpoint selection uses validation loss. Test
documents never supply training pairs. A manifest records the source hash, seed,
base model, document splits, and pair counts. An existing experiment directory is
never overwritten. The service can load a trained checkpoint by setting
`RERANKER_MODEL` to its absolute directory and restarting it.

The evaluator compares BM25, semantic search, hybrid RRF, and hybrid plus reranking
on the same question set and corpus. It records per-question rankings and aggregate
Recall@5, MRR@5, and nDCG@5. Offline BM25 is a separate lexical baseline: production
uses Postgres full-text search. Offline results do not validate SQL rankings,
database permissions, end-to-end latency, or generated-answer quality.

The original hand-authored seed has 10 documents, 20 passages, 20 answerable
questions, and 2 unanswerable questions. Its fixed document split contains 6 train,
2 validation, and 2 test documents. It is intentionally a **smoke dataset**.
Expand to at least 100 independently reviewed evaluation questions across varied
real documents before making portfolio performance claims. Include paraphrases,
multi-passage answers, OCR errors, absent answers, and adversarial instructions.
Keep near-duplicate documents together and audit split leakage. Use validation
results to tune parameters and reserve the test set for the final comparison.

For answer evaluation, independently review outputs into JSONL with
`question_id`, `answerable`, `citation_ids` (gold passage IDs), `correct`, and
`supported`. The last two fields are human labels, not model-generated judgments.
Run `python ml/score_answers.py path/to/reviewed.jsonl` for correctness, support,
citation matching, and abstention rates. It requires complete test-set coverage,
including unanswerable questions. Do not interpret retrieval scores as answer
quality. No reviewed generated-answer benchmark is bundled yet.

## Verification boundaries

Node tests cover authentication, owner filtering, citation validation, indexing,
model response checks, canonical text preservation, and audio evidence mapping.
Python tests check ranking metrics, fusion, and split isolation. The disposable
browser fixture uses fake Supabase and synthetic audio; it can call real local
models when `RAG_MODEL_URL` is set. It does not establish real Postgres RLS or SQL
search correctness. `test/rag-sql.test.js` additionally executes the unmodified
migration in embedded Postgres (PGlite) with pgvector and tests keyword/cosine/
hybrid queries, RLS isolation, rejected forged writes, and anonymous denial.
This complements, rather than replaces, verification of your hosted Supabase
configuration before production rollout. Never run credentialed deployment or paid
generation scripts as ordinary tests.

Sources: [Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search),
[RAG permissions](https://supabase.com/docs/guides/ai/rag-with-permissions),
[Sentence Transformers training](https://sbert.net/docs/cross_encoder/training_overview.html).
