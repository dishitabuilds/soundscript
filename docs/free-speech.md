# Free speech and automatic quota fallback

SoundScript supports **Kokoro** for local CPU speech generation and **Auto** for
ElevenLabs followed by Kokoro when the premium monthly allowance is exhausted.
Local inference consumes no provider credits. Your own computer or hosting still
supplies compute, storage and bandwidth; this does not promise free cloud hosting.

Kokoro's model weights are Apache-2.0, and the ONNX runtime wrapper is MIT.
Upstream: [model card](https://huggingface.co/hexgrad/Kokoro-82M) and
[kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx). Piper is another local
option, with different licensing and voice choices; browser speech synthesis can
offer playback but is not a replacement for this app's downloadable MP3 pipeline.
Kokoro is the integrated fallback, selected because it supports local generation
and reusable audio files without relying on an unofficial third-party endpoint.

## Start the local service

From the repository root, using the Python environment from the AI setup:

```powershell
uv pip install --python ml/.venv/Scripts/python.exe -r ml/requirements-speech.txt
& ml/.venv/Scripts/python.exe ml/download_speech.py
& ml/.venv/Scripts/python.exe -m uvicorn speech_service:app --app-dir ml --host 127.0.0.1 --port 8002
```

Weights are downloaded once from upstream, with SHA256 hashes recorded in
`ml/models/kokoro/download-manifest.json`. After that, inference runs locally.
The Python server returns PCM WAV; Node validates the container and uses FFmpeg
to create the MP3 format already supported by the worker, cache and player.
The current integration offers English voices Heart, Sarah, Adam and Michael.

Set backend configuration and restart the API:

```dotenv
KOKORO_URL=http://127.0.0.1:8002
TTS_PROVIDER=auto
```

Choose **Kokoro · free local** in the document voice picker to always avoid premium
speech calls. Choose **Auto · ElevenLabs → free local** for quota fallback.
The default provider also applies to short pasted-text conversions. Keep
`TTS_PROVIDER=elevenlabs` to retain premium-only behavior. Existing documents keep
their saved provider; select Auto for new uploads or re-upload an older document.

Auto first tries the configured ElevenLabs voice. A machine-readable confirmed
quota error triggers local Heart speech, with a five-minute account-key cooldown
to prevent one exhausted premium request for every chunk. A missing premium key
also uses local speech. Ordinary rate limiting/network errors retain the existing
retry policy; invalid credentials, invalid voices and corrupt audio remain visible.
If Kokoro is unavailable, the job fails with a useful error and can be retried.
Voice changes are disclosed in the picker. Auto has its own cache namespace,
including both voice and model IDs; its cached audio may use either narrator.
Directly selected premium voices never silently change provider.

The application's per-user daily character cap still protects server resources.
It is separate from ElevenLabs' monthly allowance and also applies to local speech.
Public deployment must host this service on reachable infrastructure; a public API
cannot use a visitor's `localhost`. Keep the service private; for remote hosts use
HTTPS and the same `KOKORO_SERVICE_TOKEN` on Node and Python. Do not expose an
unauthenticated local server through a reverse proxy.

## Verify without paid speech

`node --test test/free-tts.test.js` covers quota fallback, account cooldown, auth
errors, cache separation, invalid WAV responses and actual FFmpeg MP3 conversion.
The ordinary browser fixture keeps speech synthetic. For an additional disposable
demo with simulated quota exhaustion and real Kokoro output, run:

```powershell
$env:KOKORO_URL='http://127.0.0.1:8002'
$env:TTS_PROVIDER='auto'
$env:FIXTURE_REAL_TTS='true'
$env:FIXTURE_ELEVEN_QUOTA='true'
$env:FIXTURE_API_PORT='5106'
$env:FIXTURE_WEB_PORT='5177'
node scripts/browser-fixture.js
```

Open `http://127.0.0.1:5177`. The fixture uses disposable in-memory storage and a
fake premium key. Its only permitted real speech request goes to local Kokoro;
no paid synthesis occurs.
