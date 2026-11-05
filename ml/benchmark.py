"""Human-annotated SciFact ranking experiments with frozen candidates and splits."""

import argparse
import hashlib
import json
import math
import random
import time
from collections import Counter, defaultdict
from pathlib import Path

from evaluate import tokens, fuse

BASE = "cross-encoder/ms-marco-MiniLM-L6-v2"
EMBEDDER = "sentence-transformers/all-MiniLM-L6-v2"


class BM25:
    def __init__(self, passages):
        self.counts = [Counter(tokens(p["text"])) for p in passages]
        self.lengths = [sum(c.values()) for c in self.counts]
        self.avg = sum(self.lengths) / max(len(self.lengths), 1)
        self.postings = defaultdict(list)
        for i, count in enumerate(self.counts):
            for term, tf in count.items():
                self.postings[term].append((i, tf))

    def rank(self, question, limit=40):
        scores = Counter()
        n = len(self.counts)
        for term in set(tokens(question)):
            posting = self.postings.get(term, [])
            idf = math.log(1 + (n - len(posting) + 0.5) / (len(posting) + 0.5))
            for i, tf in posting:
                scores[i] += (
                    idf
                    * tf
                    * 2.2
                    / (tf + 1.2 * (0.25 + 0.75 * self.lengths[i] / max(self.avg, 1)))
                )
        return sorted(scores, key=lambda i: (-scores[i], i))[:limit]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    ids = {p["id"] for p in data["passages"]}
    partitions = {p["id"]: p.get("split") for p in data["passages"]}
    if len(ids) != len(data["passages"]):
        raise ValueError("Duplicate passage IDs")
    seen, memberships = set(), {}
    for q in data["queries"]:
        if q["id"] in seen or not q["relevant"] or not set(q["relevant"]) <= ids:
            raise ValueError("Invalid relevance labels")
        seen.add(q["id"])
        for pid in q["relevant"]:
            if partitions[pid] is not None and partitions[pid] != q["split"]:
                raise ValueError(
                    "Evidence document partition differs from its question split"
                )
            if pid in memberships and memberships[pid] != q["split"]:
                raise ValueError("Positive document leaks across splits")
            memberships[pid] = q["split"]
    by_text = {}
    for p in data["passages"]:
        text = " ".join(p["text"].lower().split())
        split = p.get("split") or memberships.get(p["id"])
        if split and text in by_text and by_text[text] != split:
            raise ValueError("Duplicate evidence text leaks across splits")
        if split:
            by_text[text] = split
    return data


def prepare(args):
    cache = Path(args.raw)
    corpus = json.loads((cache / "corpus.json").read_text(encoding="utf-8"))
    queries = {
        str(q["_id"]): q["text"]
        for q in json.loads((cache / "queries.json").read_text(encoding="utf-8"))
    }
    qrels = json.loads((cache / "qrels.json").read_text(encoding="utf-8"))
    labels = {}
    for split, rows in qrels.items():
        groups = defaultdict(set)
        for row in rows:
            if row["score"] > 0:
                groups[str(row["query-id"])].add(str(row["corpus-id"]))
        labels[split] = groups
    test_docs = {pid for ids in labels["test"].values() for pid in ids}
    # Union connected positive documents before choosing validation groups.
    parent = {}

    def root(pid):
        parent.setdefault(pid, pid)
        if parent[pid] != pid:
            parent[pid] = root(parent[pid])
        return parent[pid]

    eligible = {qid: ids for qid, ids in labels["train"].items() if not ids & test_docs}
    for ids in eligible.values():
        first = sorted(ids)[0]
        for pid in ids:
            parent[root(pid)] = root(first)
    validation_docs = {
        pid
        for ids in eligible.values()
        for pid in ids
        if int(hashlib.sha256(root(pid).encode()).hexdigest()[:8], 16) % 5 == 0
    }
    rows = []
    for qid, ids in sorted(eligible.items()):
        rows.append(
            {
                "id": qid,
                "text": queries[qid],
                "relevant": sorted(ids),
                "split": "validation" if ids & validation_docs else "train",
            }
        )
    rows += [
        {"id": qid, "text": queries[qid], "relevant": sorted(ids), "split": "test"}
        for qid, ids in sorted(labels["test"].items())
    ]
    passages = [
        {
            "id": str(p["_id"]),
            "text": (p["title"] + ". " + p["text"]).strip(),
            "split": "test"
            if str(p["_id"]) in test_docs
            else "validation"
            if str(p["_id"]) in validation_docs
            else "train",
        }
        for p in corpus
    ]
    manifest = {
        "dataset": "BEIR SciFact",
        "license": "CC-BY-SA-4.0",
        "source": "https://huggingface.co/datasets/BeIR/scifact",
        "qrels_source": "https://huggingface.co/datasets/BeIR/scifact-qrels",
        "original_project": "https://github.com/allenai/scifact",
        "review": "Original authors' human relevance annotations; no new human review claimed.",
        "passages": len(passages),
        "queries": {
            split: sum(q["split"] == split for q in rows)
            for split in ("train", "validation", "test")
        },
        "excluded_overlapping_train_queries": len(labels["train"]) - len(eligible),
        "split_policy": "Original test labels frozen. Remove training queries whose positive documents occur in test; connected positive-document groups choose validation by SHA256 mod 5. Training negatives exclude all held-out documents.",
        "raw_sha256": {
            name: digest(cache / name)
            for name in ("corpus.json", "queries.json", "qrels.json")
        },
    }
    output = Path(args.data)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {"manifest": manifest, "passages": passages, "queries": rows},
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    load(output)
    print(json.dumps(manifest, indent=2), flush=True)


def candidates(args):
    data = load(args.data)
    passages = data["passages"]
    lexical = BM25(passages)
    result = []
    for q in data["queries"]:
        keyword = lexical.rank(q["text"])
        result.append(
            {"query_id": q["id"], "bm25": keyword, "candidates": keyword[:20]}
        )
    output = {
        "dataset_sha256": digest(args.data),
        "candidate_method": "BM25 top 20, fixed for both rerankers",
        "candidates": result,
    }
    Path(args.candidates).parent.mkdir(parents=True, exist_ok=True)
    Path(args.candidates).write_text(json.dumps(output) + "\n", encoding="utf-8")
    print(f"Saved frozen candidate rankings for {len(result)} questions", flush=True)


def metric(ids, gold):
    gold = set(gold)
    if not gold or len(ids) != len(set(ids)):
        raise ValueError(
            "Ranking metrics require nonempty gold labels and distinct ranked IDs"
        )
    hits = [int(pid in gold) for pid in ids]
    dcg = sum(hit / math.log2(i + 2) for i, hit in enumerate(hits[:10]))
    ideal = sum(1 / math.log2(i + 2) for i in range(min(10, len(gold))))
    return {
        "ndcg@10": dcg / ideal,
        "mrr@10": next((1 / (i + 1) for i, hit in enumerate(hits[:10]) if hit), 0),
        "recall@5": sum(hits[:5]) / len(gold),
        "recall@30": sum(hits[:30]) / len(gold),
    }


def evaluate(args):
    import torch
    from sentence_transformers import CrossEncoder
    from context import select_context

    torch.set_num_threads(4)
    data = load(args.data)
    cache = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    if cache["dataset_sha256"] != digest(args.data):
        raise ValueError("Candidate cache does not match dataset")
    by_id = {r["query_id"]: r for r in cache["candidates"]}
    selected = [q for q in data["queries"] if q["split"] == args.split]
    if not selected:
        raise ValueError("No questions in split")
    model = CrossEncoder(args.model, device="cpu", max_length=128)
    if args.quantize:
        torch.ao.quantization.quantize_dynamic(
            model.model, {torch.nn.Linear}, dtype=torch.qint8, inplace=True
        )
    rows = []
    start = time.perf_counter()
    for n, query in enumerate(selected):
        ranks = by_id[query["id"]]
        candidates = ranks["candidates"]
        pairs = [
            (
                query["text"],
                select_context(query["text"], data["passages"][i]["text"])
                if args.context == "sentences"
                else data["passages"][i]["text"],
            )
            for i in candidates
        ]
        scores = model.predict(pairs, batch_size=8, show_progress_bar=False)
        reranked = sorted(
            zip(scores, candidates), key=lambda pair: (-float(pair[0]), pair[1])
        )
        rankings = {"bm25": ranks["bm25"]}
        rankings["reranked"] = [i for _, i in reranked]
        for method, ranking in rankings.items():
            ids = [data["passages"][i]["id"] for i in ranking]
            rows.append(
                {
                    "query_id": query["id"],
                    "method": method,
                    **metric(ids, query["relevant"]),
                    "top10": ids[:10],
                }
            )
        if (n + 1) % 25 == 0:
            print(
                f"Evaluated {n + 1}/{len(selected)} {args.split} questions", flush=True
            )
    summary = {
        method: {
            key: sum(r[key] for r in rows if r["method"] == method) / len(selected)
            for key in ("ndcg@10", "mrr@10", "recall@5", "recall@30")
        }
        for method in ("bm25", "reranked")
    }
    report = {
        "dataset_sha256": digest(args.data),
        "candidates_sha256": digest(args.candidates),
        "model": args.model,
        "context": args.context,
        "split": args.split,
        "questions": len(selected),
        "max_length": 128,
        "quantized": args.quantize,
        "elapsed_seconds": time.perf_counter() - start,
        "summary": summary,
        "results": rows,
        "limitations": [
            "SciFact claim-to-abstract retrieval is a domain benchmark, not an in-app paragraph benchmark.",
            "Human qrels are sparse: unjudged passages are treated as nonrelevant.",
            "Test overlap with pretraining corpora cannot be ruled out.",
            "Offline BM25 differs from production Postgres hybrid search.",
            "The input budget is 128 tokens; the reported context policy determines which source sentences enter it.",
        ],
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2), flush=True)


def train(args):
    import torch
    from datasets import Dataset
    from sentence_transformers import (
        CrossEncoder,
        CrossEncoderTrainer,
        CrossEncoderTrainingArguments,
    )
    from sentence_transformers.cross_encoder.losses import BinaryCrossEntropyLoss
    from ranking_loss import HardNegativesRankingLoss

    torch.set_num_threads(4)
    data = load(args.data)
    train_docs = [p for p in data["passages"] if p["split"] == "train"]
    bm25 = BM25(train_docs)
    queries = [q for q in data["queries"] if q["split"] == "train"]
    pairs = []
    ranking_rows = []
    for query in queries:
        gold = set(query["relevant"])
        pairs.extend(
            {"question": query["text"], "passage": p["text"], "label": 1.0}
            for p in train_docs
            if p["id"] in gold
        )
        negatives = [
            train_docs[i]
            for i in bm25.rank(query["text"], 40)
            if train_docs[i]["id"] not in gold
        ][:2]
        pairs.extend(
            {"question": query["text"], "passage": p["text"], "label": 0.0}
            for p in negatives
        )
        if len(negatives) == 2:
            ranking_rows.extend(
                {
                    "question": query["text"],
                    "positive": p["text"],
                    "negative1": negatives[0]["text"],
                    "negative2": negatives[1]["text"],
                }
                for p in train_docs
                if p["id"] in gold
            )
    model = CrossEncoder(BASE, device="cpu", max_length=128)
    # Adapt the final two transformer blocks and scoring layers on local CPU.
    # The same input budget is used for the untouched baseline and tuned model.
    for name, parameter in model.model.named_parameters():
        parameter.requires_grad = any(
            part in name
            for part in (
                "encoder.layer.4.",
                "encoder.layer.5.",
                "pooler.",
                "classifier.",
            )
        )
    output = Path(args.output)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use an empty output directory")
    config = CrossEncoderTrainingArguments(
        output_dir=str(output / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=4 if args.loss == "ranking" else 8,
        learning_rate=1e-5,
        warmup_steps=0.1,
        seed=42,
        save_strategy="epoch",
        save_total_limit=2,
        report_to="none",
        use_cpu=True,
        dataloader_pin_memory=False,
        logging_steps=20,
    )
    training_rows = ranking_rows if args.loss == "ranking" else pairs
    loss = (
        HardNegativesRankingLoss(
            model, num_negatives=0, scale=1.0, activation_fn=torch.nn.Identity()
        )
        if args.loss == "ranking"
        else BinaryCrossEntropyLoss(model)
    )
    trainer = CrossEncoderTrainer(
        model=model,
        args=config,
        train_dataset=Dataset.from_list(training_rows),
        loss=loss,
    )
    trainer.train()
    model.save_pretrained(str(output))
    manifest = {
        "base_model": BASE,
        "dataset_sha256": digest(args.data),
        "seed": 42,
        "epochs": args.epochs,
        "training_queries": len(queries),
        "training_pairs": len(ranking_rows) * 3
        if args.loss == "ranking"
        else len(pairs),
        "loss": args.loss,
        "training_rows": len(training_rows),
        "max_length": 128,
        "trainable_layers": "Last two transformer blocks, pooler and classifier",
        "training_document_ids": [p["id"] for p in train_docs],
        "negative_mining": "Two BM25 hard negatives, only from training documents; unjudged negatives may include unlabeled relevant text.",
        "selection": "Evaluate epoch checkpoints on validation ranking before freezing the test comparison.",
    }
    (output / "training-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Saved model trained on {len(training_rows)} {args.loss} rows from {len(queries)} human-labeled questions",
        flush=True,
    )


def compare(args):
    baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
    tuned = json.loads(Path(args.tuned).read_text(encoding="utf-8"))
    if any(
        baseline[key] != tuned[key]
        for key in (
            "dataset_sha256",
            "candidates_sha256",
            "split",
            "max_length",
            "quantized",
        )
    ):
        raise ValueError("Reports must share dataset, candidates and split")

    def values(report):
        return {
            r["query_id"]: r["ndcg@10"]
            for r in report["results"]
            if r["method"] == "reranked"
        }

    before, after = values(baseline), values(tuned)
    if set(before) != set(after):
        raise ValueError("Questions differ")
    diffs = [after[qid] - before[qid] for qid in sorted(before)]
    data = load(args.data)
    selected = {q["id"]: q for q in data["queries"] if q["id"] in before}
    parent = {}

    def root(pid):
        parent.setdefault(pid, pid)
        if parent[pid] != pid:
            parent[pid] = root(parent[pid])
        return parent[pid]

    for q in selected.values():
        first = q["relevant"][0]
        for pid in q["relevant"]:
            parent[root(pid)] = root(first)
    groups = defaultdict(list)
    for qid in before:
        groups[root(selected[qid]["relevant"][0])].append(after[qid] - before[qid])
    clusters = list(groups.values())
    rng = random.Random(42)
    means = []
    for _ in range(5000):
        sample = [d for group in rng.choices(clusters, k=len(clusters)) for d in group]
        means.append(sum(sample) / len(sample))
    means.sort()
    comparisons = getattr(args, "comparisons", 1)
    if comparisons < 1:
        raise ValueError("comparisons must be positive")
    tail = 0.025 / comparisons
    promotion_interval = [
        means[int(5000 * tail)],
        means[min(4999, int(5000 * (1 - tail)) - 1)],
    ]
    result = {
        "queries": len(diffs),
        "split": baseline["split"],
        "metric": "ndcg@10",
        "baseline_context": baseline.get("context", "prefix"),
        "tuned_context": tuned.get("context", "prefix"),
        "context_changed": baseline.get("context", "prefix")
        != tuned.get("context", "prefix"),
        "baseline": baseline["summary"]["reranked"],
        "tuned": tuned["summary"]["reranked"],
        "mean_delta": sum(diffs) / len(diffs),
        "evidence_clusters": len(clusters),
        "paired_cluster_bootstrap_95_ci": [means[125], means[4874]],
        "wins": sum(d > 0 for d in diffs),
        "ties": sum(d == 0 for d in diffs),
        "losses": sum(d < 0 for d in diffs),
        "comparisons": comparisons,
        "promotion_confidence_level": 1 - 0.05 / comparisons,
        "promotion_interval": promotion_interval,
        "promotion_passed": baseline["split"] == "test" and promotion_interval[0] > 0,
        "interpretation": "Promotion requires a positive lower bound on the test bootstrap interval, adjusted for the declared number of comparisons. Claims sharing evidence are resampled together. Context-policy changes are pipeline gains, not isolated fine-tuning gains.",
    }
    Path(args.output).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action", choices=["prepare", "candidates", "train", "evaluate", "compare"]
    )
    parser.add_argument("--raw", default="ml/.cache/scifact")
    parser.add_argument("--data", default="ml/data/scifact-reviewed.json")
    parser.add_argument("--candidates", default="ml/runs/scifact-candidates.json")
    parser.add_argument("--split", choices=["validation", "test"], default="validation")
    parser.add_argument("--model", default=BASE)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--loss", choices=["bce", "ranking"], default="bce")
    parser.add_argument("--quantize", action="store_true")
    parser.add_argument("--context", choices=["prefix", "sentences"], default="prefix")
    parser.add_argument("--comparisons", type=int, default=1)
    parser.add_argument("--output", default="ml/runs/scifact-report.json")
    parser.add_argument("--baseline")
    parser.add_argument("--tuned")
    args = parser.parse_args()
    {
        "prepare": prepare,
        "candidates": candidates,
        "train": train,
        "evaluate": evaluate,
        "compare": compare,
    }[args.action](args)
