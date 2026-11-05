"""Score independently reviewed answers; never use the generating model as judge.

JSONL records: question_id, answerable, citation_ids (seed passage IDs), and
human-reviewed booleans correct and supported. Supports abstention questions.
"""

import argparse
import json
from pathlib import Path
from evaluate import load_corpus


def score(data, records):
    questions = {
        q["id"]: q
        for d in data["documents"]
        if d["split"] == "test"
        for q in d["questions"]
    }
    questions.update(
        {q["id"]: q for q in data.get("unanswerable", []) if q["split"] == "test"}
    )
    if not records or len({r["question_id"] for r in records}) != len(records):
        raise ValueError("Supply distinct reviewed predictions")
    if {r["question_id"] for r in records} != set(questions):
        raise ValueError(
            "Predictions must cover the full test set, including unanswerable questions"
        )
    abstentions, correct, supported, cited = [], [], [], []
    for row in records:
        gold = questions[row["question_id"]]["relevant"]
        if any(
            type(row.get(key)) is not bool
            for key in ("answerable", "correct", "supported")
        ):
            raise ValueError("Review labels must be explicit booleans")
        citations = row["citation_ids"]
        if not isinstance(citations, list) or any(
            not isinstance(c, str) for c in citations
        ):
            raise ValueError("citation_ids must be a list of passage IDs")
        correct.append(row["correct"])
        if not gold:
            abstentions.append(not row["answerable"] and not citations)
        elif row["answerable"]:
            supported.append(row["supported"])
            cited.append(bool(citations) and set(citations) <= set(gold))
    mean = lambda values: sum(values) / len(values) if values else None
    return {
        "questions": len(records),
        "answer_correctness": mean(correct),
        "supported_answer_fraction": mean(supported),
        "citation_precision_per_answer": mean(cited),
        "unanswerable_abstention_rate": mean(abstentions),
        "review_method": "Independent human labels; citation match checked against gold passage IDs",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("predictions")
    parser.add_argument("--data", default="ml/data/seed.json")
    args = parser.parse_args()
    records = [
        json.loads(line)
        for line in Path(args.predictions).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    print(json.dumps(score(load_corpus(args.data), records), indent=2))
