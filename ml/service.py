"""Private CPU-friendly embedding/reranking service. No document persistence."""

import hmac
import os
from functools import lru_cache
from threading import Lock

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field
from context import select_context
from serving_config import load_serving_config
from sentence_transformers import CrossEncoder, SentenceTransformer
import torch

torch.set_num_threads(int(os.getenv("MODEL_THREADS", "2")))
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
SERVING = load_serving_config()
RERANKER_MODEL = SERVING["model"]
inference_lock = Lock()


def authenticate(request: Request, authorization: str = Header(default="")):
    token = os.getenv("MODEL_SERVICE_TOKEN", "")
    if token:
        if not hmac.compare_digest(authorization, "Bearer " + token):
            raise HTTPException(401, "Invalid service token")
    elif request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "Configure MODEL_SERVICE_TOKEN for remote access")


app = FastAPI(
    title="SoundScript retrieval models", dependencies=[Depends(authenticate)]
)


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=32)


class RerankRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1000)
    texts: list[str] = Field(min_length=1, max_length=40)


@lru_cache
def embedder():
    return SentenceTransformer(EMBEDDING_MODEL, device="cpu")


@lru_cache
def reranker():
    model = CrossEncoder(
        RERANKER_MODEL,
        device="cpu",
        max_length=SERVING["max_length"],
        revision=SERVING.get("revision"),
    )
    if SERVING["quantize"]:
        torch.ao.quantization.quantize_dynamic(
            model.model, {torch.nn.Linear}, dtype=torch.qint8, inplace=True
        )
    return model


def check_texts(texts):
    if any(not text.strip() or len(text) > 2000 for text in texts):
        raise HTTPException(422, "Text must contain 1–2000 characters")


@app.get("/health")
def health():
    return {
        "ok": True,
        "embedding_model": EMBEDDING_MODEL,
        "reranker_model": RERANKER_MODEL,
        "reranker_max_length": SERVING["max_length"],
        "reranker_quantized": SERVING["quantize"],
        "context": SERVING["context"],
        "revision": SERVING.get("revision"),
    }


@app.post("/embed")
def embed(body: EmbedRequest):
    check_texts(body.texts)
    with inference_lock:
        vectors = embedder().encode(
            body.texts, normalize_embeddings=True, show_progress_bar=False
        )
    return {"model": EMBEDDING_MODEL, "embeddings": vectors.tolist()}


@app.post("/rerank")
def rerank(body: RerankRequest):
    check_texts(body.texts)
    with inference_lock:
        texts = (
            [select_context(body.question, text) for text in body.texts]
            if SERVING["context"] == "sentences"
            else body.texts
        )
        scores = reranker().predict(
            [(body.question, text) for text in texts], show_progress_bar=False
        )
    return {"model": RERANKER_MODEL, "scores": scores.tolist()}
