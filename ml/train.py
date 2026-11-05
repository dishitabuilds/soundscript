"""Fine-tune a cross-encoder using train-only hard negatives and validation loss."""

import argparse
import hashlib
import json
from pathlib import Path

from evaluate import load_corpus, lexical_ranking


def make_pairs(documents, split):
    docs = [d for d in documents if d["split"] == split]
    passages = [p for d in docs for p in d["passages"]]
    pairs = []
    for doc in docs:
        for question in doc["questions"]:
            gold = set(question["relevant"])
            for passage in passages:
                if passage["id"] in gold:
                    pairs.append(
                        {
                            "question": question["question"],
                            "passage": passage["text"],
                            "label": 1.0,
                        }
                    )
            ranked = lexical_ranking(question["question"], passages)
            # Include zero-overlap fallback negatives if keyword mining is sparse.
            ranked += [i for i in range(len(passages)) if i not in ranked]
            negatives = [passages[i] for i in ranked if passages[i]["id"] not in gold][
                :3
            ]
            pairs.extend(
                {"question": question["question"], "passage": p["text"], "label": 0.0}
                for p in negatives
            )
    return pairs


def run(args):
    import torch
    from datasets import Dataset
    from sentence_transformers import (
        CrossEncoder,
        CrossEncoderTrainer,
        CrossEncoderTrainingArguments,
    )
    from sentence_transformers.cross_encoder.losses import BinaryCrossEntropyLoss

    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    data = load_corpus(args.data)
    train_pairs = make_pairs(data["documents"], "train")
    validation_pairs = make_pairs(data["documents"], "validation")
    if not train_pairs or not validation_pairs:
        raise ValueError("Training and validation documents are required")
    model = CrossEncoder(args.model, device="cpu", max_length=512)
    output = Path(args.output)
    if output.exists() and any(output.iterdir()):
        raise ValueError(
            "Choose an empty output directory to preserve prior experiments"
        )
    training = CrossEncoderTrainingArguments(
        output_dir=str(output / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=4,
        per_device_eval_batch_size=4,
        learning_rate=2e-5,
        warmup_steps=0.1,
        seed=args.seed,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        save_total_limit=1,
        report_to="none",
        dataloader_pin_memory=False,
        use_cpu=True,
    )
    trainer = CrossEncoderTrainer(
        model=model,
        args=training,
        train_dataset=Dataset.from_list(train_pairs),
        eval_dataset=Dataset.from_list(validation_pairs),
        loss=BinaryCrossEntropyLoss(model),
    )
    trainer.train()
    model.save_pretrained(str(output))
    manifest = {
        "base_model": args.model,
        "dataset_sha256": hashlib.sha256(Path(args.data).read_bytes()).hexdigest(),
        "seed": args.seed,
        "epochs": args.epochs,
        "training_pairs": len(train_pairs),
        "validation_pairs": len(validation_pairs),
        "train_documents": [
            d["id"] for d in data["documents"] if d["split"] == "train"
        ],
        "validation_documents": [
            d["id"] for d in data["documents"] if d["split"] == "validation"
        ],
        "negative_mining": "BM25 within each split; up to 3 negatives per query",
        "warning": "Seed-data smoke training only. Evaluate on larger held-out documents before production use.",
    }
    (output / "training-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="ml/data/seed.json")
    parser.add_argument("--model", default="cross-encoder/ms-marco-MiniLM-L6-v2")
    parser.add_argument("--output", default="ml/models/soundscript-reranker")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    run(parser.parse_args())
