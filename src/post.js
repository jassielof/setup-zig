import fs from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as glob from "@actions/glob";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function pathSize(root, seen, limit, total) {
  if (total.value > limit) return;
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch {
    return 0;
  }
  const identity = process.platform === "win32"
    ? path.resolve(root).toLowerCase()
    : path.resolve(root);
  if (seen.has(identity)) return;
  seen.add(identity);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    total.value += stat.size;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(root)) {
    await pathSize(path.join(root, entry), seen, limit, total);
    if (total.value > limit) return;
  }
}

async function cacheSize(patterns, limit) {
  const globber = await glob.create(patterns.join("\n"), {
    followSymbolicLinks: false,
  });
  const matches = await globber.glob();
  const seen = new Set();
  const total = { value: 0 };
  for (const match of matches) {
    await pathSize(match, seen, limit, total);
    if (total.value > limit) break;
  }
  return total.value;
}

async function main() {
  const key = core.getState("build-cache-key");
  const restoredKey = core.getState("restored-cache-key");
  const pathsJson = core.getState("build-cache-paths");
  if (!key || !pathsJson) return;
  if (restoredKey === key) {
    core.info(
      `The exact Zig build cache '${key}' was restored; nothing to save`,
    );
    return;
  }

  try {
    const paths = JSON.parse(pathsJson);
    const rawLimit = core.getInput("cache-size-limit").trim();
    const limitMiB = rawLimit === "" ? 0 : Number(rawLimit);
    if (!Number.isFinite(limitMiB) || limitMiB < 0) {
      core.warning(
        `Skipping Zig build cache save: invalid cache-size-limit '${rawLimit}'`,
      );
      return;
    } else if (limitMiB > 0) {
      const limit = limitMiB * 1024 * 1024;
      const size = await cacheSize(paths, limit);
      if (size > limit) {
        core.warning(
          `Skipping Zig build cache save: ${
            (size / 1024 / 1024).toFixed(1)
          } MiB exceeds the ${limitMiB} MiB limit`,
        );
        return;
      }
      core.info(`Zig build cache size: ${(size / 1024 / 1024).toFixed(1)} MiB`);
    }

    await cache.saveCache(paths, key);
    core.info(`Saved Zig build cache '${key}'`);
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("already exists")) {
      core.info(`Zig build cache '${key}' already exists`);
    } else core.warning(`Could not save the Zig build cache: ${message}`);
  }
}

await main();
