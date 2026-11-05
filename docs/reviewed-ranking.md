# Reviewed ranking benchmark

The seed corpus is retained for fast smoke tests. The larger experiment uses the
original authors' human relevance judgments from
[SciFact](https://github.com/allenai/scifact), mirrored by
[BEIR](https://huggingface.co/datasets/BeIR/scifact) with its
[relevance labels](https://huggingface.co/datasets/BeIR/scifact-qrels).
These are external human annotations, not newly human-reviewed SoundScript data.
The data is CC-BY-SA-4.0; retain upstream attribution when redistributing derived
corpora. This benchmark measures scientific claim-to-abstract retrieval, not
general performance on users' uploaded paragraphs or generated-answer quality.

## Corpus and leakage control

The corpus contains 5,183 abstracts. The original 300 test queries remain frozen.
We remove 272 original training queries whose positive evidence documents also
appear in test labels. Positive documents connected by a multi-document relevance
label stay together. A deterministic document-group split leaves 465 training and
72 validation queries. Training hard negatives exclude all validation/test
evidence documents. Exact repeated evidence across splits is rejected.

Human relevance annotations are sparse. Unjudged negatives can contain relevant
text that was not labeled. We cannot rule out overlap with a pretrained model's
training corpora. The raw downloaded files and prepared corpus have recorded
SHA256 digests; large texts, model weights and caches are kept out of Git.

## Reproduce

Use the Python environment described in `docs/ai-study-assistant.md`, from the
repository root. On Unix replace the Python path with `ml/.venv/bin/python`.

```powershell
$env:HF_HOME="$PWD/ml/.cache/huggingface"
& ml/.venv/Scripts/python.exe ml/download_benchmark.py
& ml/.venv/Scripts/python.exe ml/benchmark.py prepare
& ml/.venv/Scripts/python.exe ml/benchmark.py candidates
& ml/.venv/Scripts/python.exe ml/benchmark.py train --output ml/models/scifact-reranker-cpu --epochs 2
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --quantize --output ml/runs/scifact-pretrained-validation.json
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --quantize --model ml/models/scifact-reranker-cpu/checkpoints/checkpoint-181 --output ml/runs/scifact-epoch1-validation.json
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --quantize --model ml/models/scifact-reranker-cpu --output ml/runs/scifact-epoch2-validation.json
& ml/.venv/Scripts/python.exe ml/benchmark.py train --loss ranking --epochs 1 --output ml/models/scifact-reranker-hardneg
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --quantize --model ml/models/scifact-reranker-hardneg --output ml/runs/scifact-ranking-validation.json
```

Checkpoint step numbers depend on pair counts and batch size; inspect the saved
checkpoint directory when using a changed corpus. An existing experiment directory
is never overwritten. Compare the BCE epoch checkpoints and the ranking-loss
checkpoint by validation nDCG@10 before any tuned test evaluation. The ranking
objective contrasts each positive with two explicitly mined negatives. It avoids
random in-batch negatives because related claims can share positive evidence.
Use only the selected checkpoint for test:

```powershell
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --quantize --split test --output ml/runs/scifact-pretrained-test.json
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --quantize --split test --model PATH_TO_SELECTED_CHECKPOINT --output ml/runs/scifact-tuned-test.json
& ml/.venv/Scripts/python.exe ml/benchmark.py compare --baseline ml/runs/scifact-pretrained-test.json --tuned ml/runs/scifact-tuned-test.json --output ml/runs/scifact-comparison.json
```

The large CPU experiment uses frozen BM25 top-20 candidates for both rerankers.
This isolates the ranking change without spending most CPU time embedding the
entire corpus. The existing seed evaluator still covers hybrid and semantic
search. BM25 is not the production Postgres keyword implementation.

The untouched pretrained baseline and tuned model receive the same 128-token
input budget and dynamic INT8 inference. This truncates later abstract content;
do not compare the result with published full-length SciFact leaderboards.
Fine-tuning adapts the last two transformer blocks, pooler and classifier. BCE uses
1,443 pairs; ranking loss uses 513 groups with one positive and two hard negatives
(1,539 scored query/passage pairs per epoch). The rest of the encoder
is frozen. CPU-only training uses seed 42, two BCE epochs and one ranking-loss
epoch, with selection based on validation rankings.

Reports include nDCG@10, MRR@10, Recall@5 and Recall@30, with per-query top-10 IDs.
Recall@30 for a reranked top-20 pool measures candidate coverage, not 30 generated
reranked hits. Statistical comparison uses 5,000 paired bootstrap samples grouped
by connected evidence documents, keeping related claims together. A positive
lower confidence bound on test nDCG@10 is required for promotion. `--comparisons`
applies a Bonferroni adjustment when more than one final comparison is performed.
No model is
automatically promoted based only on training loss or a validation win.

## Context-selection result

The initial fine-tuning test did not establish improvement. Validation error
inspection found that useful evidence could occur beyond the input cutoff. The
label-free `ml/context.py` selector retains the title and two useful source
sentences for scoring; it never changes stored citation text. Test it with
`--context sentences`, using both pretrained and tuned weights on validation.

The pretrained focused policy won validation and was fixed before the second test
comparison. Test nDCG@10 improved from 0.620927 to 0.694184. Its adjusted 97.5%
gain interval is [0.034431, 0.114238], accounting for two comparisons. This gain
belongs to the context policy, not fine-tuning. See the complete
[experiment record](../ml/experiments/scifact-reviewed/README.md), including the
public-test reuse caveat and the inconclusive fine-tuning result.

The focused validation/test commands add `--context sentences` to `evaluate`.
For the final pipeline comparison use `--comparisons 2`:

```powershell
& ml/.venv/Scripts/python.exe ml/benchmark.py compare --baseline ml/runs/scifact-pretrained-test.json --tuned ml/runs/scifact-context-test.json --comparisons 2 --output ml/runs/scifact-context-comparison.json
```

## Serving an accepted CPU profile

The saved accepted profile fixes the model revision, context policy, token budget
and quantization. Start it separately from the existing service:

```powershell
$env:RERANKER_CONFIG="$PWD/ml/experiments/scifact-reviewed/accepted-cpu-profile.json"
& ml/.venv/Scripts/python.exe -m uvicorn service:app --app-dir ml --host 127.0.0.1 --port 8003
```

The backend can opt in with `RAG_MODEL_URL=http://127.0.0.1:8003`. The ordinary
512-token default is preserved and has not been compared against this CPU profile.
A
benchmark improvement establishes a result on this domain benchmark. Test the
accepted model against independently labeled in-app passages, scanned documents,
and unanswerable questions before broader production use.

`ml/promote.py --comparison PATH --tuned-report PATH` writes an opt-in serving
configuration only when the test gate passes and the model is a known pretrained
base or an existing local checkpoint. `RERANKER_CONFIG` loads that profile and
rejects unapproved or invalid profiles.
Failed or mismatched comparisons cannot promote a model. It preserves the prior
configuration and does not modify a running production service.
