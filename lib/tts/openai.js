const axios = require("axios");
const { TtsError, retryAfterMs, requireMp3 } = require("./error");

const MODEL_ID = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const VOICE_ID = process.env.OPENAI_TTS_VOICE || "alloy";

// The API has no voices endpoint; this is the documented set.
const VOICES = [
  { id: "alloy", name: "Alloy", description: "neutral, balanced" },
  { id: "echo", name: "Echo", description: "clear, precise" },
  { id: "fable", name: "Fable", description: "expressive, story-telling" },
  { id: "onyx", name: "Onyx", description: "deep, resonant" },
  { id: "nova", name: "Nova", description: "bright, friendly" },
  { id: "shimmer", name: "Shimmer", description: "warm, gentle" },
];

function classify(error) {
  if (!error.response) {
    return new TtsError(error.message || "Network error reaching OpenAI.", {
      retryable: true,
    });
  }

  const status = error.response.status;

  let detail = "";
  let code = "";
  try {
    const data = error.response.data;
    const parsed = Buffer.isBuffer(data) ? JSON.parse(data.toString()) : data;
    detail = parsed?.error?.message || "";
    code = parsed?.error?.code || "";
  } catch (_) {
    // Status code alone is enough to classify.
  }

  if (status === 401) {
    return new TtsError("Invalid OpenAI API key.", {
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    const header = error.response.headers?.["retry-after"];
    return new TtsError(detail || "OpenAI rate limit or quota exceeded.", {
      status,
      retryable: code !== "insufficient_quota",
      retryAfterMs: retryAfterMs(header),
    });
  }
  if (status >= 500) {
    return new TtsError(detail || `OpenAI server error (${status}).`, {
      status,
      retryable: true,
    });
  }

  return new TtsError(detail || `OpenAI error (${status}).`, {
    status,
    retryable: false,
  });
}

/**
 * Synthesise one piece of text via OpenAI's speech API. MP3 out, matching the
 * ElevenLabs provider so the stitcher never has to care which provider made a
 * given chunk.
 *
 * @param {string} text
 * @param {{ voiceId?: string, modelId?: string, timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
async function synthesize(text, options = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new TtsError("OPENAI_API_KEY is not set.", { retryable: false });
  }

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      {
        model: options.modelId || MODEL_ID,
        voice: options.voiceId || VOICE_ID,
        input: text,
        response_format: "mp3",
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
        timeout: options.timeoutMs || 60000,
      },
    );
    return requireMp3(res, "OpenAI");
  } catch (error) {
    if (error instanceof TtsError) throw error;
    throw classify(error);
  }
}

async function listVoices() {
  return VOICES;
}

module.exports = { synthesize, listVoices, classify, VOICE_ID, MODEL_ID };
