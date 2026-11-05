"""Download the upstream Kokoro ONNX assets and record integrity hashes."""

import hashlib
import json
import urllib.request
from pathlib import Path


if __name__ == "__main__":
    directory = Path("ml/models/kokoro")
    directory.mkdir(parents=True, exist_ok=True)
    rows = []
    for filename in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        url = (
            "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
            + filename
        )
        target = directory / filename
        if not target.exists():
            print("Downloading " + filename, flush=True)
            temporary = target.with_suffix(".download")
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(target)
        rows.append(
            {
                "file": filename,
                "url": url,
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "bytes": target.stat().st_size,
            }
        )
    (directory / "download-manifest.json").write_text(
        json.dumps(rows, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(rows, indent=2), flush=True)
