"""Load the existing defaults or an explicitly approved CPU serving profile."""

import json
import os
from pathlib import Path


def load_serving_config(environment=None):
    env = os.environ if environment is None else environment
    if env.get("RERANKER_CONFIG"):
        config = json.loads(Path(env["RERANKER_CONFIG"]).read_text(encoding="utf-8"))
        if config.get("promotion_passed") is not True:
            raise ValueError("The serving profile has not passed its evaluation gate")
    else:
        config = {
            "model": env.get("RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L6-v2"),
            "max_length": int(env.get("RERANKER_MAX_LENGTH", "512")),
            "quantize": env.get("RERANKER_QUANTIZE") == "true",
            "context": env.get("RERANKER_CONTEXT", "prefix"),
            "revision": env.get("RERANKER_REVISION"),
        }
    if (
        not isinstance(config.get("model"), str)
        or not config["model"]
        or type(config.get("max_length")) is not int
        or not 1 <= config["max_length"] <= 512
    ):
        raise ValueError("Invalid model or input budget in serving configuration")
    if type(config.get("quantize")) is not bool or config.get("context") not in {
        "prefix",
        "sentences",
    }:
        raise ValueError("Invalid inference policy in serving configuration")
    return config
