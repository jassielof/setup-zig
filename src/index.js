import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import { parse } from "@jassielof/zon";
import { parseKey, parseSignature, verifySignature } from "./minisign.js";

const ZIGLANG_ORG = "https://ziglang.org";
const VERSIONS_JSON = `${ZIGLANG_ORG}/download/index.json`;
const MACH_VERSIONS_JSON = "https://pkg.machengine.org/zig/index.json";
const CANONICAL_DEV = `${ZIGLANG_ORG}/builds`;
const CANONICAL_RELEASE = `${ZIGLANG_ORG}/download`;
const MIRRORS_URL = `${ZIGLANG_ORG}/download/community-mirrors.txt`;
const MINISIGN_KEY = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

import * as semver from "@std/semver";

function versionLessThan(curVer, minVer) {
  try {
    const cur = semver.parse(curVer);
    const min = semver.parse(minVer);
    return semver.lessThan(cur, min);
  } catch {
    return false;
  }
}

function detectPlatformAndArch() {
  const platformMap = {
    win32: "windows",
    darwin: "macos",
    linux: "linux",
    freebsd: "freebsd",
  };
  const archMap = {
    x64: "x86_64",
    arm64: "aarch64",
    ia32: "x86",
    arm: "arm",
  };

  let platform = platformMap[os.platform()];
  let arch = archMap[os.arch()];

  if (!platform || !arch) {
    throw new Error(`Unsupported platform: ${os.platform()} ${os.arch()}`);
  }
  return { platform, arch };
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch JSON from ${url}: ${resp.status} ${resp.statusText}`,
    );
  }
  return await resp.json();
}

async function resolveVersion(versionInput) {
  let raw = versionInput;
  if (!raw) {
    try {
      if (await fileExists("build.zig.zon")) {
        const zonText = await fs.readFile("build.zig.zon", "utf8");
        const parsed = parse(zonText);
        let zonVersion =
          parsed.mach_zig_version ||
          parsed.machZigVersion ||
          parsed.minimum_zig_version ||
          parsed.minimumZigVersion;
        if (zonVersion) {
          if (
            zonVersion &&
            typeof zonVersion === "object" &&
            "value" in zonVersion
          ) {
            zonVersion = zonVersion.value;
          }
          raw = String(zonVersion);
          core.info(`Resolved version '${raw}' from build.zig.zon`);
        }
      }
    } catch (e) {
      core.info(`Could not read or parse build.zig.zon: ${e.message}`);
    }
  }

  if (!raw) {
    raw = "latest";
  }

  if (raw === "master" || raw === "dev") {
    const index = await fetchJson(VERSIONS_JSON);
    return {
      version: "master",
      url: null,
      resolvedVersion: index.master.version,
      index,
    };
  }

  if (raw === "latest") {
    const index = await fetchJson(VERSIONS_JSON);
    const versions = Object.keys(index).filter((v) => v !== "master");
    versions.sort((a, b) => {
      const aParts = a.split(".").map(Number);
      const bParts = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if (aParts[i] !== bParts[i]) {
          return bParts[i] - aParts[i];
        }
      }
      return 0;
    });
    const latestVersion = versions[0];
    return {
      version: latestVersion,
      url: null,
      resolvedVersion: latestVersion,
      index,
    };
  }

  if (raw.includes("mach")) {
    const machIndex = await fetchJson(MACH_VERSIONS_JSON);
    if (!(raw in machIndex)) {
      throw new Error(`Mach nominated version '${raw}' not found`);
    }
    const resolved = machIndex[raw].version;
    return {
      version: resolved,
      url: null,
      resolvedVersion: resolved,
      index: null,
    };
  }

  return { version: raw, url: null, resolvedVersion: raw, index: null };
}

function getTarballFilename(version, arch, platform) {
  const ext = platform === "windows" ? "zip" : "tar.xz";

  // Before 0.15.1, Zig used 'armv7a' as the arch name for ARM binaries
  let displayArch = arch;
  if (arch === "arm" && versionLessThan(version, "0.15.1")) {
    displayArch = "armv7a";
  }

  // Before 0.14.1, Zig tarballs were named like 'zig-linux-x86_64-0.14.0' (reversed arch and OS)
  let name;
  if (
    versionLessThan(version, "0.15.0-dev.631+9a3540d61") &&
    versionLessThan(version, "0.14.1")
  ) {
    name = `zig-${platform}-${displayArch}-${version}`;
  } else {
    name = `zig-${displayArch}-${platform}-${version}`;
  }
  return `${name}.${ext}`;
}

async function getMirrors() {
  const preferredMirror = core.getInput("mirror");
  if (preferredMirror) {
    if (
      preferredMirror.includes("://ziglang.org/") ||
      preferredMirror.startsWith("ziglang.org/")
    ) {
      throw new Error(
        "'https://ziglang.org' cannot be used as mirror override; for more information see README.md",
      );
    }
    core.info(`Using mirror: ${preferredMirror}`);
    return [preferredMirror];
  }

  let mirrors = [];
  try {
    const mirrorsResponse = await fetch(MIRRORS_URL);
    if (mirrorsResponse.ok) {
      mirrors = (await mirrorsResponse.text())
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    }
  } catch (e) {
    core.info(
      `Failed to fetch mirror list, using default mirrors: ${e.message}`,
    );
  }

  if (mirrors.length === 0) {
    mirrors = [
      "https://pkg.machengine.org/zig",
      "https://zigmirror.hryx.net/zig",
      "https://zig.linus.dev/zig",
      "https://zig.squirl.dev",
      "https://zig.florent.dev",
      "https://zig.mirror.mschae23.de/zig",
      "https://zigmirror.meox.dev",
      "https://ziglang.freetls.fastly.net",
      "https://zig.tilok.dev",
      "https://zig-mirror.tsimnet.eu/zig",
      "https://zig.karearl.com/zig",
      "https://pkg.earth/zig",
      "https://fs.liujiacai.net/zigbuilds",
    ];
  }

  // Shuffle mirrors to distribute load
  return mirrors
    .map((m) => [m, Math.random()])
    .sort((a, b) => a[1] - b[1])
    .map((a) => a[0]);
}

async function downloadFromMirror(mirror, tarballFilename) {
  const url = `${mirror}/${tarballFilename}`;
  core.info(`Downloading tool cache from ${url}`);
  const tarballPath = await tc.downloadTool(
    `${url}?source=github-jassielof-setup-zig`,
  );

  core.info(`Downloading signature from ${url}.minisig`);
  const signatureResponse = await fetch(
    `${url}.minisig?source=github-jassielof-setup-zig`,
  );
  if (!signatureResponse.ok) {
    throw new Error(
      `Signature download failed: ${signatureResponse.statusText}`,
    );
  }
  const signatureData = Buffer.from(await signatureResponse.arrayBuffer());
  const tarballData = await fs.readFile(tarballPath);

  const key = await parseKey(MINISIGN_KEY);
  const signature = parseSignature(signatureData);
  if (!(await verifySignature(key, signature, tarballData))) {
    throw new Error(`Signature verification failed for ${url}`);
  }

  // Parse the trusted comment to validate the tarball name.
  const match = /^timestamp:\d+\s+file:([^\s]+)\s+hashed$/.exec(
    signature.trusted_comment.toString(),
  );
  if (match === null || match[1] !== tarballFilename) {
    throw new Error(`Filename verification failed for ${url}`);
  }

  return tarballPath;
}

async function downloadTarball(resolvedVersion, arch, platform) {
  const tarballFilename = getTarballFilename(resolvedVersion, arch, platform);
  const mirrors = await getMirrors();

  for (const mirror of mirrors) {
    core.info(`Attempting mirror: ${mirror}`);
    try {
      return await downloadFromMirror(mirror, tarballFilename);
    } catch (e) {
      core.info(`Mirror failed with error: ${e.message}`);
    }
  }

  // Canonical fallback
  const canonicalBase = resolvedVersion.includes("-dev")
    ? CANONICAL_DEV
    : `${CANONICAL_RELEASE}/${resolvedVersion}`;
  core.info(`Attempting official canonical URL: ${canonicalBase}`);
  return await downloadFromMirror(canonicalBase, tarballFilename);
}

function getToolchainCacheKey(platform, arch, resolvedVersion, url) {
  const runnerOs =
    { linux: "Linux", macos: "macOS", windows: "Windows" }[platform] ||
    platform;
  const runnerArch = { x86_64: "X64", aarch64: "ARM64" }[arch] || arch;

  let segment;
  if (resolvedVersion.includes("-dev") || resolvedVersion === "master") {
    const digest = crypto
      .createHash("sha256")
      .update(url)
      .digest("hex")
      .substring(0, 16);
    segment = `master-${digest}`;
  } else {
    segment =
      resolvedVersion
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown";
  }
  return `zig-toolchain-${runnerOs}-${runnerArch}-${segment}`;
}

async function hashDependencyFiles(globPatterns) {
  const globber = await glob.create(globPatterns);
  const files = await globber.glob();
  files.sort();

  const hash = crypto.createHash("sha256");
  let hasFiles = false;
  for (const file of files) {
    const stat = await fs.stat(file);
    if (stat.isFile()) {
      hasFiles = true;
      const content = await fs.readFile(file);
      hash.update(content);
    }
  }
  return hasFiles ? hash.digest("hex") : "default";
}

async function main() {
  try {
    const { platform, arch } = detectPlatformAndArch();
    const versionInput = core.getInput("version");
    const { version, resolvedVersion, index } =
      await resolveVersion(versionInput);

    let url = null;
    const key = `${arch}-${platform}`;
    if (index && index[version] && index[version][key]) {
      url = index[version][key].tarball;
    } else {
      url = buildCanonicalUrl(resolvedVersion, arch, platform);
    }

    function buildCanonicalUrl(v, a, p) {
      const ext = p === "windows" ? "zip" : "tar.xz";
      let displayA = a;
      if (a === "arm" && versionLessThan(v, "0.15.1")) {
        displayA = "armv7a";
      }
      let name;
      if (
        versionLessThan(v, "0.15.0-dev.631+9a3540d61") &&
        versionLessThan(v, "0.14.1")
      ) {
        name = `zig-${p}-${displayA}-${v}`;
      } else {
        name = `zig-${displayA}-${p}-${v}`;
      }
      return `${resolvedVersion.includes("-dev") ? CANONICAL_DEV : `${CANONICAL_RELEASE}/${v}`}/${name}.${ext}`;
    }

    const installDir = path.join(os.homedir(), ".zig");
    const toolchainCacheKey = getToolchainCacheKey(
      platform,
      arch,
      resolvedVersion,
      url,
    );
    const useCache = core.getBooleanInput("cache");
    const useToolchainCache = core.getBooleanInput("cache-toolchain");

    let restoredToolchain = false;
    if (useCache && useToolchainCache) {
      core.info(
        `Attempting to restore Zig toolchain with key: ${toolchainCacheKey}`,
      );
      const hitKey = await cache.restoreCache([installDir], toolchainCacheKey);
      if (hitKey) {
        // Double check marker file exists and matches
        const markerPath = path.join(installDir, ".setup-zig-toolchain-marker");
        if (await fileExists(markerPath)) {
          const markerContent = await fs.readFile(markerPath, "utf8");
          if (markerContent === `${resolvedVersion}\n${url}\n`) {
            core.info(`Zig toolchain restored from cache successfully`);
            restoredToolchain = true;
          }
        }
      }
    }

    if (!restoredToolchain) {
      core.info(`Installing Zig ${resolvedVersion} (${arch}-${platform})`);
      const tarballPath = await downloadTarball(
        resolvedVersion,
        arch,
        platform,
      );

      core.info(`Extracting Zig archive...`);
      const tempExtractParent = path.join(os.homedir(), ".zig-temp-extract");
      if (await fileExists(tempExtractParent)) {
        await fs.rm(tempExtractParent, { recursive: true, force: true });
      }
      await fs.mkdir(tempExtractParent, { recursive: true });

      let extractedDir;
      if (tarballPath.endsWith(".zip")) {
        extractedDir = await tc.extractZip(tarballPath, tempExtractParent);
      } else {
        extractedDir = await tc.extractTar(
          tarballPath,
          tempExtractParent,
          "xJ",
        );
      }

      const entries = await fs.readdir(extractedDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(extractedDir, e.name));
      let innerDir = extractedDir;
      if (dirs.length === 1) {
        innerDir = dirs[0];
      } else {
        for (const d of dirs) {
          if (
            (await fileExists(path.join(d, "zig"))) ||
            (await fileExists(path.join(d, "zig.exe")))
          ) {
            innerDir = d;
            break;
          }
        }
      }

      if (await fileExists(installDir)) {
        await fs.rm(installDir, { recursive: true, force: true });
      }
      await fs.mkdir(path.dirname(installDir), { recursive: true });
      await fs.rename(innerDir, installDir);

      await fs.rm(tempExtractParent, { recursive: true, force: true });

      // Write marker file
      const markerPath = path.join(installDir, ".setup-zig-toolchain-marker");
      await fs.writeFile(markerPath, `${resolvedVersion}\n${url}\n`, "utf8");

      if (useCache && useToolchainCache) {
        core.info(
          `Saving Zig toolchain to cache with key: ${toolchainCacheKey}`,
        );
        try {
          await cache.saveCache([installDir], toolchainCacheKey);
        } catch (e) {
          core.info(`Failed to save toolchain cache: ${e.message}`);
        }
      }
    }

    // Add binary to PATH
    core.addPath(installDir);

    // Resolve binary path and verify execution
    const binaryName = platform === "windows" ? "zig.exe" : "zig";
    const zigBinaryPath = path.join(installDir, binaryName);
    if (!(await fileExists(zigBinaryPath))) {
      throw new Error(`Zig binary not found at ${zigBinaryPath}`);
    }

    // Get verified version
    const { stdout } = await exec.getExecOutput(`"${zigBinaryPath}"`, [
      "version",
    ]);
    const zigVersion = stdout.trim();
    core.info(`Verified Zig installation: version ${zigVersion}`);

    // Set up build cache
    if (useCache) {
      const runnerOs =
        { linux: "Linux", macos: "macOS", windows: "Windows" }[platform] ||
        platform;
      const runnerArch = { x86_64: "X64", aarch64: "ARM64" }[arch] || arch;
      const dependencyHash = await hashDependencyFiles(
        core.getInput("cache-dependency-path"),
      );
      const target = core.getInput("target") || "default";

      const buildCacheKey = `zig-build-${runnerOs}-${runnerArch}-${zigVersion}-${target}-${dependencyHash}`;
      const buildRestoreKeys = [
        `zig-build-${runnerOs}-${runnerArch}-${zigVersion}-${target}-`,
      ];

      const globalCacheDir =
        process.env.ZIG_GLOBAL_CACHE_DIR ||
        path.join(
          process.env.RUNNER_TEMP || os.tmpdir(),
          "setup-zig-global-cache",
        );
      core.exportVariable("ZIG_GLOBAL_CACHE_DIR", globalCacheDir);

      const additionalCachePaths = core
        .getInput("cache-path")
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const buildCachePaths = [globalCacheDir, ...additionalCachePaths];

      // Ensure cache directories exist
      await fs.mkdir(path.join(globalCacheDir, "tmp"), { recursive: true });
      await fs.mkdir(path.join(globalCacheDir, "p"), { recursive: true });
      for (const p of additionalCachePaths) {
        if (!p.includes("*")) {
          await fs.mkdir(p, { recursive: true });
        }
      }

      core.info(
        `Attempting restore of Zig build cache with key: ${buildCacheKey}`,
      );
      const restoredKey = await cache.restoreCache(
        buildCachePaths,
        buildCacheKey,
        buildRestoreKeys,
      );
      if (restoredKey) {
        core.info(`Zig build cache hit (key: ${restoredKey})`);
      } else {
        core.info("Zig build cache miss");
      }

      core.saveState("build-cache-key", buildCacheKey);
      core.saveState("build-cache-paths", JSON.stringify(buildCachePaths));
      core.saveState("restored-cache-key", restoredKey || "");
    }
  } catch (err) {
    core.setFailed(err.message);
  }
}

main();
