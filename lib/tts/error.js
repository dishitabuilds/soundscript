class TtsError extends Error {
  constructor(
    message,
    {
      status,
      retryable = false,
      retryAfterMs = null,
      quotaExceeded = false,
    } = {},
  ) {
    super(message);
    this.name = "TtsError";
    this.status = status;
    // Whether trying the identical request again could plausibly succeed. A 429
    // or a 5xx is worth another go; a 401 or a 422 will fail identically
    // forever, and retrying it just burns the budget slower.
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.quotaExceeded = quotaExceeded;
  }
}

function retryAfterMs(header) {
  if (header == null || header === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// Header/signature validation catches empty and JSON success responses before
// storage. FFmpeg still performs the full decode during document assembly.
function requireMp3(response, provider) {
  const audio = Buffer.from(response.data || []);
  const type = response.headers?.["content-type"] || "";
  const signature =
    audio.length >= 4 &&
    (audio.subarray(0, 3).toString("ascii") === "ID3" ||
      (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0));
  if (
    !signature ||
    (type && !/^(audio\/(mpeg|mp3)|application\/octet-stream)(;|$)/i.test(type))
  ) {
    // Repeating a successful paid request could bill again. Fail explicitly.
    throw new TtsError(provider + " returned invalid or empty MP3 audio.", {
      status: 502,
      retryable: false,
    });
  }
  return audio;
}

module.exports = { TtsError, retryAfterMs, requireMp3 };
