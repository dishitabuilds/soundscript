"""Fetch the authors' public BEIR mirror; prepare records exact local hashes."""

import json
from pathlib import Path
from datasets import load_dataset


if __name__ == "__main__":
    directory = Path("ml/.cache/scifact")
    directory.mkdir(parents=True, exist_ok=True)
    corpus_revision = "b3b5335604bf5ee3c4447671af975ea25143d4f5"
    qrels_revision = "2938d17dc3b09882fdb8c12bbbe2e2dc0e75a029"
    corpus = load_dataset(
        "BeIR/scifact", "corpus", split="corpus", revision=corpus_revision
    )
    queries = load_dataset(
        "BeIR/scifact", "queries", split="queries", revision=corpus_revision
    )
    qrels = load_dataset("BeIR/scifact-qrels", revision=qrels_revision)
    (directory / "corpus.json").write_text(json.dumps(list(corpus)), encoding="utf-8")
    (directory / "queries.json").write_text(json.dumps(list(queries)), encoding="utf-8")
    (directory / "qrels.json").write_text(
        json.dumps({key: list(value) for key, value in qrels.items()}), encoding="utf-8"
    )
    print(
        f"Downloaded {len(corpus)} abstracts and {len(queries)} human-annotated claims"
    )
