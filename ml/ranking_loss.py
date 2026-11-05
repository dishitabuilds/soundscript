"""Listwise relevance loss using only explicitly mined training negatives."""

from sentence_transformers.cross_encoder.losses import MultipleNegativesRankingLoss


class HardNegativesRankingLoss(MultipleNegativesRankingLoss):
    def get_in_batch_negatives(self, anchors, candidates):
        # Related SciFact claims can share evidence. Treating another positive
        # in the batch as an automatic negative can introduce incorrect labels.
        # The parent forward still scores both supplied hard negatives.
        return iter(())
