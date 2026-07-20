class TtsError extends Error {
  constructor(
    message,
    { status, retryable = false, retryAfterMs = null } = {},
  ) {
    super(message);
    this.name = "TtsError";
    this.status = status;
    // Whether trying the identical request again could plausibly succeed. A 429
    // or a 5xx is worth another go; a 401 or a 422 will fail identically
    // forever, and retrying it just burns the budget slower.
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = { TtsError };
