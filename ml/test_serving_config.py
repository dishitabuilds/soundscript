import json
import tempfile
import unittest
from pathlib import Path
from serving_config import load_serving_config


class ServingConfigTests(unittest.TestCase):
    def test_existing_application_defaults_are_preserved(self):
        config = load_serving_config({})
        self.assertEqual(config["max_length"], 512)
        self.assertEqual(config["context"], "prefix")
        self.assertFalse(config["quantize"])

    def test_unapproved_profile_cannot_override_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text(json.dumps({"promotion_passed": False}))
            with self.assertRaises(ValueError):
                load_serving_config({"RERANKER_CONFIG": str(path)})

    def test_approved_profile_keeps_its_exact_scoring_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            path.write_text(
                json.dumps(
                    {
                        "promotion_passed": True,
                        "model": "model",
                        "max_length": 128,
                        "quantize": True,
                        "context": "sentences",
                    }
                )
            )
            config = load_serving_config(
                {"RERANKER_CONFIG": str(path), "RERANKER_MAX_LENGTH": "512"}
            )
            self.assertEqual(config["max_length"], 128)
            self.assertEqual(config["context"], "sentences")


if __name__ == "__main__":
    unittest.main()
