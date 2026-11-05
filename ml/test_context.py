import unittest
from context import select_context


class ContextTests(unittest.TestCase):
    def test_later_evidence_is_selected_without_changing_the_source_sentences(self):
        text = "A study of neural networks. We describe the research setting. The survey includes many datasets. Dropout masks activations during training. Dropout is disabled at inference."
        selected = select_context("Is dropout used during inference?", text)
        self.assertIn("Dropout is disabled at inference.", selected)
        self.assertIn("A study of neural networks.", selected)
        self.assertNotIn("The survey includes many datasets.", selected)

    def test_no_overlap_preserves_original_context(self):
        text = "First sentence. Second sentence. Third sentence."
        self.assertEqual(select_context("Audio synthesis", text), text)


if __name__ == "__main__":
    unittest.main()
