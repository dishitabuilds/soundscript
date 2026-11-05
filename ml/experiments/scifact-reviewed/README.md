# Reviewed ranking experiment — 5 November 2026

The experiment uses 5,183 SciFact abstracts and the original authors' human
relevance labels. There are 465 training, 72 validation and 300 test queries after
excluding training queries whose evidence overlaps test. Test evidence is excluded
from negative mining. Dataset revisions, SHA256 digests, model revision, package
versions and split rules are recorded in `protocol.json`.

## Observed results

With frozen BM25 top-20 candidates, a 128-token input budget and INT8 CPU inference:

- Pretrained reranker with prefix context: test nDCG@10 **0.620927**.
- Validation-selected fine-tuned model with prefix context: **0.621833**.
  The difference is **+0.000905**, with evidence-cluster bootstrap 95% CI
  **[-0.004721, +0.006577]**. Fine-tuning alone did not establish improvement.
- Pretrained reranker with query-based sentence selection: **0.694184**.
  The difference from prefix context is **+0.073256**, or **11.80% relative**.
  The Bonferroni-adjusted 97.5% interval is **[+0.034431, +0.114238]**.
- BM25 alone: test nDCG@10 **0.661676**. The focused-context profile's point score
  also exceeds BM25; the confidence comparison above is against the prefix
  reranker, not a statistical claim against BM25.

The focused profile's MRR@10 is **0.665392**, versus **0.584489** for the prefix
reranker. Recall@5 rises from **0.693667** to **0.752556**.

The gain belongs to **context selection**, not fine-tuning. With sentence selection,
the pretrained weights slightly outperformed the tuned weights on validation
(0.702781 vs 0.700487), so pretrained weights were selected. The trained model
remains available locally for reproducible comparison.

## Experiment integrity

Two BCE checkpoints and an explicit-hard-negative ranking-loss checkpoint were
compared on validation before tuned test scoring. The strongest trained candidate's
test result was inconclusive and is retained in `finetuning-comparison.json`.

Validation error inspection identified relevant information late in abstracts.
Sentence selection was then implemented and compared on validation using both
pretrained and tuned weights. `context-selection.json` fixes the stronger policy
before its test evaluation. The original 300-query public test set was reused for
this second pipeline comparison, so the promotion interval accounts for two
declared comparisons. This is an exploratory public-benchmark result; fresh,
independently labeled in-app data is needed for a deployment-quality generalization
claim.

Bootstrap sampling keeps claims sharing connected evidence documents together:
300 questions form 247 evidence clusters. Results include 5,000 paired samples.
The context comparison has 69 wins, 188 ties and 43 losses. Fine-tuning alone has
7 wins, 288 ties and 5 losses.

## Serving decision and limits

The 128-token focused CPU profile passed its benchmark gate. Its local opt-in
configuration is `ml/models/accepted-cpu-profile.json`, with the base model pinned
to commit `233902d25c440f23af6f7d6e94d2946bac0bee0a`. Load it with
`RERANKER_CONFIG`; its scoring policy takes precedence over individual model flags.
The ordinary application's 512-token default is preserved. **This experiment does
not establish superiority over that unmeasured 512-token configuration.**

This is scientific claim-to-abstract retrieval, not the app's per-document hybrid
search. Both rerankers use the same candidate lists and token budget. Sparse human
qrels can leave relevant abstracts unjudged, and pretraining overlap is unknown.
The large corpus is downloaded by revision-pinned scripts instead of committed as
a large text artifact. Source labels and data are CC-BY-SA-4.0; retain attribution.

Sources: [SciFact](https://github.com/allenai/scifact),
[BEIR corpus](https://huggingface.co/datasets/BeIR/scifact),
[human relevance labels](https://huggingface.co/datasets/BeIR/scifact-qrels).

See `docs/reviewed-ranking.md` for commands and interpretation. Per-query rankings,
validation comparisons, manifests, selections and confidence results are retained
beside this file. Checkpoints and model weights remain gitignored.
