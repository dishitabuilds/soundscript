const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

test("unavailable FFmpeg rejects cleanly and scratch directories are cleaned", async () => {
  const moduleId = require.resolve("ffmpeg-static");
  const originalPath = require(moduleId);
  const stitchId = require.resolve("../lib/audio/stitch");
  const originalModule = require.cache[stitchId];
  require.cache[moduleId].exports = path.join(
    os.tmpdir(),
    randomUUID(),
    "missing-ffmpeg",
  );
  delete require.cache[stitchId];
  try {
    const { makeSilence, withWorkDir } = require(stitchId);
    let directory;
    await assert.rejects(
      withWorkDir(async (dir) => {
        directory = dir;
        await makeSilence(0.1, path.join(dir, "audio.mp3"));
      }),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(
      require("node:fs/promises").stat(directory),
      (error) => error.code === "ENOENT",
    );
  } finally {
    require.cache[moduleId].exports = originalPath;
    if (originalModule) require.cache[stitchId] = originalModule;
    else delete require.cache[stitchId];
  }
});
