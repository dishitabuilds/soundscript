const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const elevenlabs = require("../lib/tts/elevenlabs");
const openai = require("../lib/tts/openai");
const { resolveSettings, withRetry } = require("../lib/tts");

// Synthetic credentials live only inside this isolated test process. No dotenv.
function fakeKey(t, name) {
  const original = process.env[name];
  process.env[name] = "test-only-placeholder";
  t.after(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);

test("ElevenLabs sends the documented request and returns MP3 bytes", async (t) => {
  fakeKey(t, "ELEVEN_API_KEY");
  t.mock.method(axios, "post", async (url, body, config) => {
    assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/test-voice");
    assert.deepEqual(body, { text: "Hello.", model_id: "test-model" });
    assert.equal(config.headers["xi-api-key"], "test-only-placeholder");
    assert.equal(config.params.output_format, "mp3_44100_128");
    assert.equal(config.responseType, "arraybuffer");
    assert.equal(config.timeout, 1234);
    return { data: mp3, headers: { "content-type": "audio/mpeg" } };
  });
  assert.deepEqual(
    await elevenlabs.synthesize("Hello.", {
      voiceId: "test-voice",
      modelId: "test-model",
      timeoutMs: 1234,
    }),
    mp3,
  );
});

for (const provider of [elevenlabs, openai]) {
  for (const data of [Buffer.alloc(0), Buffer.from('{"error":"not audio"}')]) {
    test("provider rejects empty or non-audio success without paid retries", async (t) => {
      fakeKey(t, "ELEVEN_API_KEY");
      fakeKey(t, "OPENAI_API_KEY");
      const post = t.mock.method(axios, "post", async () => ({
        data,
        headers: { "content-type": "audio/mpeg" },
      }));
      await assert.rejects(
        withRetry(() => provider.synthesize("Hello.")),
        (err) => err.name === "TtsError" && !err.retryable,
      );
      assert.equal(post.mock.callCount(), 1);
    });
  }
}

test("missing credentials never issue a synthesis request", async (t) => {
  const original = process.env.ELEVEN_API_KEY;
  delete process.env.ELEVEN_API_KEY;
  t.after(() => {
    if (original !== undefined) process.env.ELEVEN_API_KEY = original;
  });
  const post = t.mock.method(axios, "post", () =>
    assert.fail("must not call network"),
  );
  await assert.rejects(elevenlabs.synthesize("Hello."), /ELEVEN_API_KEY/);
  assert.equal(post.mock.callCount(), 0);
});

test("quota-exceeded 429 is permanent", () => {
  const err = elevenlabs.classify({
    response: {
      status: 429,
      data: { detail: { status: "quota_exceeded", message: "No credits." } },
    },
  });
  assert.equal(err.retryable, false);
  assert.match(err.message, /quota/i);
});

test("permission-denied and unavailable voice/model requests are permanent", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const err = elevenlabs.classify({
      response: {
        status,
        data: {
          detail: {
            status: "missing_permissions",
            message: "Request rejected.",
          },
        },
      },
    });
    assert.equal(err.retryable, false);
  }
});

test("Retry-After supports HTTP dates", () => {
  const date = new Date(Date.now() + 10000).toUTCString();
  const err = elevenlabs.classify({
    response: { status: 429, data: {}, headers: { "retry-after": date } },
  });
  assert.ok(err.retryAfterMs >= 8000 && err.retryAfterMs <= 10000);
});

test("OpenAI insufficient quota is not retried as a rate limit", () => {
  assert.equal(
    openai.classify({
      response: {
        status: 429,
        data: {
          error: { code: "insufficient_quota", message: "No credits." },
        },
      },
    }).retryable,
    false,
  );
});

test("provider prototype names and non-string voice settings are rejected", () => {
  for (const settings of [
    { provider: "constructor" },
    { provider: "__proto__" },
    { voiceId: {} },
    { modelId: ["model"] },
    { voiceId: "voice?injected=true" },
  ])
    assert.throws(() => resolveSettings(settings), /provider|voiceId|modelId/i);
});
