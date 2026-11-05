const axios = require("axios");
const { execFile } = require("node:child_process");
const ffmpeg = require("ffmpeg-static");
const { TtsError, requireMp3 } = require("./error");

const VOICE_ID = "af_heart";
const MODEL_ID = "kokoro-v1.0";
const VOICES = [
  { id: "af_heart", name: "Heart", description: "free local English voice" },
  { id: "af_sarah", name: "Sarah", description: "free local English voice" },
  { id: "am_adam", name: "Adam", description: "free local English voice" },
  {
    id: "am_michael",
    name: "Michael",
    description: "free local English voice",
  },
];

function wavToMp3(wav) {
  if (!ffmpeg)
    return Promise.reject(new TtsError("Local speech requires FFmpeg."));
  return new Promise((resolve, reject) => {
    const child = execFile(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "wav",
        "-i",
        "pipe:0",
        "-f",
        "mp3",
        "-codec:a",
        "libmp3lame",
        "-ar",
        "44100",
        "-b:a",
        "128k",
        "pipe:1",
      ],
      {
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error)
          return reject(new TtsError("Could not encode local speech."));
        try {
          resolve(
            requireMp3(
              { data: stdout, headers: { "content-type": "audio/mpeg" } },
              "Kokoro",
            ),
          );
        } catch (invalidAudio) {
          reject(invalidAudio);
        }
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(wav);
  });
}

async function synthesize(text, options = {}) {
  const voice = options.voiceId || VOICE_ID;
  const model = options.modelId || MODEL_ID;
  if (!process.env.KOKORO_URL)
    throw new TtsError("The free local speech service is not configured.");
  if (
    !VOICES.some((v) => v.id === voice) ||
    model !== MODEL_ID ||
    !text.trim() ||
    text.length > 2000
  ) {
    throw new TtsError("Unsupported local voice, model or text length.", {
      status: 422,
    });
  }
  let response;
  try {
    response = await axios.post(
      new URL("/speech", process.env.KOKORO_URL).href,
      { text, voice, model },
      {
        headers: {
          ...(process.env.KOKORO_SERVICE_TOKEN
            ? { Authorization: `Bearer ${process.env.KOKORO_SERVICE_TOKEN}` }
            : {}),
        },
        timeout: options.timeoutMs || 120000,
        responseType: "arraybuffer",
        maxContentLength: 32 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new TtsError("The free local speech service is unavailable.", {
      status: error.response?.status || 503,
      retryable: !error.response || error.response.status >= 500,
    });
  }
  const wav = Buffer.from(response.data);
  if (
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new TtsError("Local speech returned invalid WAV audio.", {
      status: 502,
    });
  }
  return wavToMp3(wav);
}

module.exports = {
  synthesize,
  listVoices: async () => VOICES,
  VOICE_ID,
  MODEL_ID,
  wavToMp3,
};
