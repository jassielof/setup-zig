import fs from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import * as cache from "@actions/cache";

async function dirSize(dirPath) {
  try {
    let total = 0;
    const entries = await fs.readdir(dirPath, {
      withFileTypes: true,
      recursive: true,
    });
    for (const ent of entries) {
      if (ent.isFile()) {
        try {
          const stat = await fs.stat(path.join(ent.parentPath, ent.name));
          total += stat.size;
        } catch {
          // ignore stat failures for individual files
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function main() {
  try {
    const buildCacheKey = core.getState("build-cache-key");
    const restoredCacheKey = core.getState("restored-cache-key");
    const pathsJson = core.getState("build-cache-paths");
    const globalCacheDir = core.getState("global-cache-dir");

    if (!buildCacheKey || !pathsJson) {
      core.info(
        "No build cache configuration found in state. Skipping build cache save.",
      );
      return;
    }

    const paths = JSON.parse(pathsJson);

    const sizeLimitMiB =
      parseInt(core.getInput("cache-size-limit"), 10) || 0;
    if (sizeLimitMiB > 0 && globalCacheDir) {
      const sizeLimit = sizeLimitMiB * 1024 * 1024;
      const size = await dirSize(globalCacheDir);
      if (size > sizeLimit) {
        core.info(
          `Cache directory is ${size} bytes, exceeding limit of ${sizeLimit} bytes; clearing cache`,
        );
        const entries = await fs.readdir(globalCacheDir);
        await Promise.all(
          entries.map((e) =>
            fs.rm(path.join(globalCacheDir, e), {
              recursive: true,
              force: true,
            })
          ),
        );
      } else {
        core.info(
          `Cache directory is ${size} bytes, within limit of ${sizeLimit} bytes`,
        );
      }
    }

    if (restoredCacheKey === buildCacheKey) {
      core.info(
        `Zig build cache hit on exact key '${buildCacheKey}'. Skipping save.`,
      );
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
        core.info(
          `Cache entry for key '${buildCacheKey}' already exists on the server.`,
        );
      } else {
        core.warning(`Failed to save Zig build cache: ${e.message}`);
      }
    }
  } catch (err) {
    core.setFailed(err.message);
  }
}

main();
