import * as core from "@actions/core";
import * as cache from "@actions/cache";

async function main() {
  try {
    const buildCacheKey = core.getState("build-cache-key");
    const restoredCacheKey = core.getState("restored-cache-key");
    const pathsJson = core.getState("build-cache-paths");

    if (!buildCacheKey || !pathsJson) {
      core.info("No build cache configuration found in state. Skipping build cache save.");
      return;
    }

    const paths = JSON.parse(pathsJson);

    if (restoredCacheKey === buildCacheKey) {
      core.info(`Zig build cache hit on exact key '${buildCacheKey}'. Skipping save.`);
      return;
    }

    core.info(`Saving Zig build cache with key: ${buildCacheKey}`);
    try {
      await cache.saveCache(paths, buildCacheKey);
      core.info("Zig build cache saved successfully.");
    } catch (e) {
      if (e.name === "ValidationError") {
        core.info(`Cache save validation error: ${e.message}`);
      } else if (e.message.includes("already exists")) {
        core.info(`Cache entry for key '${buildCacheKey}' already exists on the server.`);
      } else {
        core.warning(`Failed to save Zig build cache: ${e.message}`);
      }
    }
  } catch (err) {
    core.setFailed(err.message);
  }
}

main();
