"""Write an opt-in serving config only after the frozen-test ranking gate passes."""

import argparse
import json
from pathlib import Path


def approved_config(comparison, tuned_report):
    if (
        comparison.get("split") != "test"
        or comparison.get("promotion_passed") is not True
    ):
        raise ValueError(
            "The frozen-test improvement gate did not pass; keep the current reranker"
        )
    interval = comparison.get(
        "promotion_interval", comparison.get("paired_cluster_bootstrap_95_ci", [])
    )
    if len(interval) != 2 or interval[0] <= 0:
        raise ValueError("No positive lower confidence bound")
    if (
        comparison["tuned"] != tuned_report["summary"]["reranked"]
        or tuned_report["split"] != "test"
    ):
        raise ValueError("The comparison and checkpoint report differ")
    model = tuned_report["model"]
    if (
        model != "cross-encoder/ms-marco-MiniLM-L6-v2"
        and not (Path(model).resolve() / "config.json").is_file()
    ):
        raise ValueError("The selected local checkpoint is missing")
    if model != "cross-encoder/ms-marco-MiniLM-L6-v2":
        model = str(Path(model).resolve())
    return {
        "model": model,
        "revision": tuned_report.get("model_revision"),
        "context": tuned_report.get("context", "prefix"),
        "max_length": tuned_report["max_length"],
        "quantize": tuned_report["quantized"],
        "dataset_sha256": tuned_report["dataset_sha256"],
        "candidates_sha256": tuned_report["candidates_sha256"],
        "promotion_passed": True,
        "test_ndcg_delta": comparison["mean_delta"],
        "test_ci": interval,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--comparison", required=True)
    parser.add_argument("--tuned-report", required=True)
    parser.add_argument("--output", default="ml/models/accepted-reranker.json")
    args = parser.parse_args()
    config = approved_config(
        json.loads(Path(args.comparison).read_text()),
        json.loads(Path(args.tuned_report).read_text()),
    )
    output = Path(args.output)
    if output.exists():
        raise ValueError(
            "Choose a new config filename to preserve the prior deployment record"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(config, indent=2))
