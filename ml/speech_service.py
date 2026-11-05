"""Local-only Kokoro speech. Download weights once; inference has no API quota."""

import hmac
import io
import os
from functools import lru_cache
from pathlib import Path
from threading import Lock

import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field

VOICES = {"af_heart", "af_sarah", "am_adam", "am_michael"}
lock = Lock()


def authenticate(request: Request, authorization: str = Header(default="")):
    token = os.getenv("KOKORO_SERVICE_TOKEN", "")
    if token:
        if not hmac.compare_digest(authorization, "Bearer " + token):
            raise HTTPException(401, "Invalid service token")
    elif request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "A service token is required for remote access")


app = FastAPI(
    title="SoundScript free local speech", dependencies=[Depends(authenticate)]
)


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: str = "af_heart"
    model: str = "kokoro-v1.0"


@lru_cache
def engine():
    from kokoro_onnx import Kokoro
    import onnxruntime as rt

    directory = Path(os.getenv("KOKORO_MODEL_DIR", "ml/models/kokoro"))
    options = rt.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = rt.InferenceSession(
        str(directory / "kokoro-v1.0.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    return Kokoro.from_session(session, str(directory / "voices-v1.0.bin"))


@app.get("/health")
def health():
    directory = Path(os.getenv("KOKORO_MODEL_DIR", "ml/models/kokoro"))
    return {
        "ok": all(
            (directory / f).is_file() for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin")
        ),
        "model": "kokoro-v1.0",
        "voices": sorted(VOICES),
    }


@app.post("/speech")
def speech(body: Speech):
    if not body.text.strip() or body.voice not in VOICES or body.model != "kokoro-v1.0":
        raise HTTPException(422, "Unsupported voice, model, or empty text")
    with lock:
        samples, rate = engine().create(
            body.text, voice=body.voice, speed=1.0, lang="en-us"
        )
    buffer = io.BytesIO()
    sf.write(buffer, samples, rate, format="WAV", subtype="PCM_16")
    return Response(buffer.getvalue(), media_type="audio/wav")
