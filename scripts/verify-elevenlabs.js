// Read-only verification. This script never requests speech or changes settings.
require("dotenv").config();
const axios = require("axios");

async function main() {
  const key = process.env.ELEVEN_API_KEY;
  if (!key) {
    console.log(JSON.stringify({ configured: false }));
    process.exitCode = 1;
    return;
  }

  const voiceId = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
  const modelId = process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5";
  const checks = [
    ["authentication", "/v1/user", () => ({ authenticated: true })],
    [
      "subscription",
      "/v1/user/subscription",
      (data) => ({
        tier: data.tier,
        status: data.status,
        used: data.character_count,
        limit: data.character_limit,
        remaining:
          Number.isFinite(data.character_limit) &&
          Number.isFinite(data.character_count)
            ? Math.max(0, data.character_limit - data.character_count)
            : null,
      }),
    ],
    [
      "voice",
      `/v1/voices/${encodeURIComponent(voiceId)}`,
      () => ({ configuredVoiceAvailable: true }),
    ],
    [
      "model",
      "/v1/models",
      (data) => {
        const model = Array.isArray(data)
          ? data.find((m) => m.model_id === modelId)
          : null;
        return {
          configuredModelAvailable: Boolean(model?.can_do_text_to_speech),
          maximumTextLength: model?.maximum_text_length_per_request ?? null,
        };
      },
    ],
  ];
  const results = await Promise.all(
    checks.map(async ([check, endpoint, summarize]) => {
      try {
        const response = await axios.get(
          `https://api.elevenlabs.io${endpoint}`,
          {
            headers: { "xi-api-key": key },
            timeout: 20000,
            maxRedirects: 0,
          },
        );
        return {
          check,
          httpStatus: response.status,
          ...summarize(response.data),
        };
      } catch (error) {
        // Never log Axios errors, request headers, raw account data or key previews.
        const status = error.response?.data?.detail?.status;
        return {
          check,
          httpStatus: error.response?.status ?? null,
          reason:
            typeof status === "string" && /^[a-z0-9_]+$/i.test(status)
              ? status
              : error.response
                ? "request_rejected"
                : "network_failure",
        };
      }
    }),
  );
  console.log(
    JSON.stringify(
      { configured: true, speechGeneration: "NOT TESTED", results },
      null,
      2,
    ),
  );
  if (results.some((r) => r.httpStatus !== 200)) process.exitCode = 1;
}

main().catch(() => {
  console.error("Verification could not complete.");
  process.exitCode = 1;
});
