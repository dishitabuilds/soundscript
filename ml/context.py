"""Label-free sentence selection for rerankers with a small input budget."""

import math
import re
from collections import Counter

STOP = set(
    "a an the and or of to in for on by with is are was were be been being has have had as that this these those it its from at into than which who what how why does do did can could would should may might not no only".split()
)


def terms(text):
    return {
        word
        for word in re.findall(r"\w+", text.lower())
        if word not in STOP and len(word) > 1
    }


def select_context(question, text):
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if len(sentences) <= 2:
        return text
    query = terms(question)
    counts = Counter(word for s in sentences for word in terms(s))

    def relevance(index):
        overlap = query & terms(sentences[index])
        return sum(
            math.log(1 + len(sentences) / counts[word]) for word in overlap
        ) / math.sqrt(max(1, len(terms(sentences[index]))))

    ranked = sorted(range(1, len(sentences)), key=lambda i: (-relevance(i), i))
    useful = [i for i in ranked if relevance(i) > 0][:2]
    if not useful:
        return text
    # Keep the original title/first sentence and source ordering. Never rewrite
    # source claims; this is scoring context, not the quoted citation text.
    return " ".join(sentences[i] for i in sorted({0, *useful}))
