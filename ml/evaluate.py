"""Reproducible retrieval ablations. Offline lexical baseline is BM25, not PG FTS."""

import argparse
import hashlib
import json
import math
import re
import time
from collections import Counter
from pathlib import Path


def load_corpus(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    documents = data["documents"]
    ids, texts, qids = set(), {}, set()
    for doc in documents:
        if doc["split"] not in {"train", "validation", "test"}:
            raise ValueError("Invalid document split")
        for passage in doc["passages"]:
            if passage["id"] in ids:
                raise ValueError("Duplicate passage ID")
            ids.add(passage["id"])
            key = " ".join(passage["text"].lower().split())
            if key in texts and texts[key] != doc["split"]:
                raise ValueError("Duplicate passage text leaks across splits")
            texts[key] = doc["split"]
        local_ids = {p["id"] for p in doc["passages"]}
        for question in doc["questions"]:
            if (
                question["id"] in qids
                or not question["relevant"]
                or not set(question["relevant"]) <= local_ids
            ):
                raise ValueError("Invalid question labels")
            qids.add(question["id"])
    if len({d["id"] for d in documents}) != len(documents):
        raise ValueError("Duplicate source document ID")
    return data


def tokens(text):
    return re.findall(r"\w+", text.lower())


def lexical_ranking(question, passages):
    counts = [Counter(tokens(p["text"])) for p in passages]
    avg = sum(sum(c.values()) for c in counts) / max(len(counts), 1)
    scores = []
    for i, count in enumerate(counts):
        score = 0.0
        for term in set(tokens(question)):
            df = sum(term in c for c in counts)
            idf = math.log(1 + (len(counts) - df + 0.5) / (df + 0.5))
            tf = count[term]
            score += (
                idf
                * tf
                * 2.2
                / (tf + 1.2 * (0.25 + 0.75 * sum(count.values()) / max(avg, 1)))
            )
        scores.append((i, score))
    return [i for i, score in sorted(scores, key=lambda x: (-x[1], x[0])) if score > 0]


def fuse(lexical, dense, limit=20):
    scores = Counter()
    for ranking in (lexical[:40], dense[:40]):
        for rank, idx in enumerate(ranking, 1):
            scores[idx] += 1 / (60 + rank)
    return sorted(scores, key=lambda i: (-scores[i], i))[:limit]


def metrics(ranking, relevant, k=5):
    gold = set(relevant)
    if not gold:
        raise ValueError("Ranking metrics require an answerable question")
    hits = [int(p in gold) for p in ranking[:k]]
    dcg = sum(hit / math.log2(i + 2) for i, hit in enumerate(hits))
    ideal = sum(1 / math.log2(i + 2) for i in range(min(k, len(gold))))
    return {
        "recall@5": sum(hits) / len(gold),
        "mrr@5": next((1 / (i + 1) for i, hit in enumerate(hits) if hit), 0),
        "ndcg@5": dcg / ideal,
    }


def run(args):
    data = load_corpus(args.data)
    passages = [p for d in data["documents"] for p in d["passages"]]
    questions = [
        q for d in data["documents"] if d["split"] == args.split for q in d["questions"]
    ]
    if not questions:
        raise ValueError("No evaluation questions in requested split")
    embedder = reranker = vectors = None
    if not args.lexical_only:
        import torch
        from sentence_transformers import CrossEncoder, SentenceTransformer

        torch.set_num_threads(2)
        embedder = SentenceTransformer(
            "sentence-transformers/all-MiniLM-L6-v2", device="cpu"
        )
        reranker = CrossEncoder(args.reranker, device="cpu", max_length=512)
        vectors = embedder.encode(
            [p["text"] for p in passages], normalize_embeddings=True
        )
    rows = []
    for question in questions:
        started = time.perf_counter()
        lexical = lexical_ranking(question["question"], passages)
        rankings = {"bm25": lexical}
        if embedder:
            query = embedder.encode([question["question"]], normalize_embeddings=True)[
                0
            ]
            dense = sorted(
                range(len(passages)), key=lambda i: -float(vectors[i] @ query)
            )
            hybrid = fuse(lexical, dense)
            scores = reranker.predict(
                [(question["question"], passages[i]["text"]) for i in hybrid]
            )
            rankings.update(
                semantic=dense,
                hybrid=hybrid,
                hybrid_reranked=[
                    i for _, i in sorted(zip(scores, hybrid), reverse=True)
                ],
            )
        for name, ranking in rankings.items():
            ids = [passages[i]["id"] for i in ranking]
            rows.append(
                {
                    "question_id": question["id"],
                    "method": name,
                    **metrics(ids, question["relevant"]),
                    "top5": ids[:5],
                }
            )
        question["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 2)
    summary = {}
    for name in sorted({r["method"] for r in rows}):
        group = [r for r in rows if r["method"] == name]
        summary[name] = {
            key: sum(r[key] for r in group) / len(group)
            for key in ("recall@5", "mrr@5", "ndcg@5")
        }
    report = {
        "dataset_sha256": hashlib.sha256(Path(args.data).read_bytes()).hexdigest(),
        "split": args.split,
        "questions": len(questions),
        "corpus_passages": len(passages),
        "reranker": args.reranker if reranker else None,
        "summary": summary,
        "results": rows,
        "limitations": [
            "Tiny hand-authored seed: smoke test only.",
            "Offline BM25 differs from production Postgres full-text search.",
            "Ranking metrics exclude unanswerable questions and do not measure factuality or citation support.",
            "Elapsed times include all ablations; they are not production latency measurements.",
        ],
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": args.output, "summary": summary}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="ml/data/seed.json")
    parser.add_argument(
        "--split", choices=["train", "validation", "test"], default="test"
    )
    parser.add_argument("--reranker", default="cross-encoder/ms-marco-MiniLM-L6-v2")
    parser.add_argument("--lexical-only", action="store_true")
    parser.add_argument("--output", default="ml/runs/evaluation.json")
    run(parser.parse_args())
