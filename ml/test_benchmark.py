import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from benchmark import BM25, compare, load, metric
from promote import approved_config


class ReviewedBenchmarkTests(unittest.TestCase):
    def test_failed_comparisons_cannot_promote_a_checkpoint(self):
        with self.assertRaisesRegex(ValueError, "gate did not pass"):
            approved_config({"split": "test", "promotion_passed": False}, {})

    def test_lexical_index_ranks_distinct_documents(self):
        index = BM25(
            [
                {"text": "regularization prevents overfitting"},
                {"text": "audio playback position"},
            ]
        )
        self.assertEqual(index.rank("regularization overfitting")[0], 0)

    def test_metrics_reject_duplicate_ranked_ids(self):
        with self.assertRaises(ValueError):
            metric(["a", "a"], ["a"])
        self.assertEqual(metric(["wrong", "a"], ["a"])["mrr@10"], 0.5)

    def test_positive_documents_cannot_leak_across_splits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data.json"
            path.write_text(
                json.dumps(
                    {
                        "passages": [{"id": "p", "text": "evidence"}],
                        "queries": [
                            {"id": "q1", "split": "train", "relevant": ["p"]},
                            {"id": "q2", "split": "test", "relevant": ["p"]},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "leaks"):
                load(path)

    def test_unjudged_training_duplicates_of_test_evidence_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data.json"
            path.write_text(
                json.dumps(
                    {
                        "passages": [
                            {
                                "id": "train-copy",
                                "text": "same evidence",
                                "split": "train",
                            },
                            {"id": "test", "text": "same evidence", "split": "test"},
                        ],
                        "queries": [{"id": "q", "split": "test", "relevant": ["test"]}],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "leaks"):
                load(path)

    def test_cluster_comparison_requires_matched_protocol_and_positive_test_ci(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = {
                "passages": [{"id": "p1", "text": "one"}, {"id": "p2", "text": "two"}],
                "queries": [
                    {"id": "q1", "split": "test", "relevant": ["p1"]},
                    {"id": "q2", "split": "test", "relevant": ["p1"]},
                    {"id": "q3", "split": "test", "relevant": ["p2"]},
                ],
            }
            (root / "data.json").write_text(json.dumps(data), encoding="utf-8")
            for name, value in [("base", 0.4), ("tuned", 0.6)]:
                report = {
                    "dataset_sha256": "same",
                    "candidates_sha256": "same",
                    "split": "test",
                    "max_length": 128,
                    "quantized": True,
                    "summary": {"reranked": {"ndcg@10": value}},
                    "results": [
                        {"query_id": f"q{i}", "method": "reranked", "ndcg@10": value}
                        for i in (1, 2, 3)
                    ],
                }
                (root / f"{name}.json").write_text(json.dumps(report), encoding="utf-8")
            args = SimpleNamespace(
                data=root / "data.json",
                baseline=root / "base.json",
                tuned=root / "tuned.json",
                output=root / "comparison.json",
            )
            with contextlib.redirect_stdout(io.StringIO()):
                compare(args)
            result = json.loads(args.output.read_text())
            self.assertTrue(result["promotion_passed"])
            self.assertEqual(result["evidence_clusters"], 2)
            tuned = json.loads(args.tuned.read_text())
            tuned["quantized"] = False
            args.tuned.write_text(json.dumps(tuned))
            with self.assertRaises(ValueError):
                compare(args)


if __name__ == "__main__":
    unittest.main()
