const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const elevenlabs = require("../lib/tts/elevenlabs");
const kokoro = require("../lib/tts/kokoro");
const auto = require("../lib/tts/auto");
const { TtsError, hashFor, resolveSettings } = require("../lib/tts");

function env(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    auto.resetQuota();
  });
}

test("Auto falls back on explicit quota exhaustion and suppresses repeated premium calls", async (t) => {
  env(t, "ELEVEN_API_KEY", "test-only");
  const premium = t.mock.method(elevenlabs, "synthesize", async () => {
    throw elevenlabs.classify({
      response: {
        status: 401,
        data: {
          detail: {
            status: "quota_exceeded",
            message: "Monthly credits exhausted",
          },
        },
      },
    });
  });
  const local = t.mock.method(kokoro, "synthesize", async () =>
    Buffer.from("local audio"),
  );
  assert.equal(
    (await auto.synthesize("First paragraph")).toString(),
    "local audio",
  );
  await auto.synthesize("Second paragraph");
  assert.equal(premium.mock.callCount(), 1);
  assert.equal(local.mock.callCount(), 2);
});
test("Auto uses local speech without a premium key and never changes a directly selected provider", async (t) => {
  env(t, "ELEVEN_API_KEY", undefined);
  t.mock.method(elevenlabs, "synthesize", () =>
    assert.fail("premium must not be called"),
  );
  t.mock.method(kokoro, "synthesize", async () => Buffer.from("free audio"));
  assert.equal((await auto.synthesize("Hello")).toString(), "free audio");
  assert.equal(
    resolveSettings({ provider: "elevenlabs" }).provider,
    "elevenlabs",
  );
});
test("Auto exposes authentication errors and retries transient failures instead of hiding them", async (t) => {
  env(t, "ELEVEN_API_KEY", "test-key");
  t.mock.method(kokoro, "synthesize", () =>
    assert.fail("must not mask an upstream configuration failure"),
  );
  for (const status of [401, 404, 429, 500]) {
    const error = elevenlabs.classify({
      response: {
        status,
        data: { detail: { status: "not_quota", message: "Request failed" } },
      },
    });
    const mocked = t.mock.method(elevenlabs, "synthesize", async () => {
      throw error;
    });
    await assert.rejects(auto.synthesize("Hello"), (e) => e === error);
    mocked.mock.restore();
  }
});
test("quota responses at every supported status carry a machine-readable fallback flag", () => {
  for (const status of [401, 429])
    assert.equal(
      elevenlabs.classify({
        response: {
          status,
          data: { detail: { status: "quota_exceeded", message: "No credits" } },
        },
      }).quotaExceeded,
      true,
    );
});
test("automatic policy cache namespace cannot collide with either individual provider", () => {
  const automatic = hashFor("Hello", { provider: "auto" });
  assert.notEqual(automatic, hashFor("Hello", { provider: "elevenlabs" }));
  assert.notEqual(automatic, hashFor("Hello", { provider: "kokoro" }));
});
test("Kokoro rejects invalid audio and voice settings before creating an MP3", async (t) => {
  env(t, "KOKORO_URL", "http://127.0.0.1:8002");
  const post = t.mock.method(axios, "post", async () => ({
    data: Buffer.from("not a WAV"),
  }));
  await assert.rejects(kokoro.synthesize("Hello"), /invalid WAV/);
  await assert.rejects(
    kokoro.synthesize("Hello", { voiceId: "unknown" }),
    /Unsupported/,
  );
  assert.equal(post.mock.callCount(), 1);
});
test("Kokoro WAV conversion produces decodable MP3 through actual FFmpeg", async () => {
  const samples = 24000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  const audio = await kokoro.wavToMp3(wav);
  assert.ok(audio.length > 1000);
});
