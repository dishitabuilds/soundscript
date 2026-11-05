import unittest
from evaluate import fuse, load_corpus, metrics
from train import make_pairs
from score_answers import score


class EvaluationTests(unittest.TestCase):
    def test_metrics_rank_and_recall(self):
        result = metrics(["wrong", "a", "b"], ["a", "b"])
        self.assertEqual(result["recall@5"], 1)
        self.assertEqual(result["mrr@5"], 0.5)
        self.assertLess(result["ndcg@5"], 1)

    def test_fusion_rewards_overlap(self):
        self.assertEqual(fuse([1, 2], [3, 2])[0], 2)

    def test_training_never_contains_held_out_passages(self):
        data = load_corpus("ml/data/seed.json")
        held_out = {
            p["text"]
            for d in data["documents"]
            if d["split"] != "train"
            for p in d["passages"]
        }
        pairs = make_pairs(data["documents"], "train")
        self.assertTrue(pairs)
        self.assertFalse(any(p["passage"] in held_out for p in pairs))

    def test_answer_evaluation_requires_all_unanswerable_cases(self):
        data = load_corpus("ml/data/seed.json")
        with self.assertRaises(ValueError):
            score(data, [{"question_id": "q-drop-1"}])

    def test_answer_evaluation_scores_abstentions_and_gold_citations(self):
        data = load_corpus("ml/data/seed.json")
        questions = [
            q for d in data["documents"] if d["split"] == "test" for q in d["questions"]
        ] + data["unanswerable"]
        records = [
            {
                "question_id": q["id"],
                "answerable": bool(q["relevant"]),
                "citation_ids": q["relevant"],
                "correct": True,
                "supported": True,
            }
            for q in questions
        ]
        self.assertEqual(score(data, records)["unanswerable_abstention_rate"], 1)


if __name__ == "__main__":
    unittest.main()
