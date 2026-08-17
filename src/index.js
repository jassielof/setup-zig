import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import { parse } from "@jassielof/zon";
import { parseKey, parseSignature, verifySignature } from "./minisign.js";
import {
  assertMinimumVersion,
  buildCacheKey,
  getTarballFilename,
  hashDependencyFiles,
  latestStableVersion,
  lines,
  parseMirrorList,
  safeKeySegment,
  shuffle,
  toolchainCacheKey,
  validateMirrorUrl,
  validateResolvedVersion,
} from "./lib.js";

const ZIGLANG_ORG = "https://ziglang.org";
const VERSIONS_JSON = `${ZIGLANG_ORG}/download/index.json`;
const MACH_VERSIONS_JSON = "https://pkg.machengine.org/zig/index.json";
const MIRRORS_URL = `${ZIGLANG_ORG}/download/community-mirrors.txt`;
const MINISIGN_KEY = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U";
const SOURCE_QUERY = "github-jassielof-setup-zig";
const FETCH_TIMEOUT_MS = 30_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_MIRROR_ATTEMPTS = 3;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const FALLBACK_MIRRORS = [
  "https://pkg.hexops.org/zig",
  "https://zigmirror.hryx.net/zig",
  "https://zig.linus.dev/zig",
  "https://zig.squirl.dev",
  "https://zig.mirror.mschae23.de/zig",
  "https://ziglang.freetls.fastly.net",
  "https://zig.tilok.dev",
  "https://zig-mirror.tsimnet.eu/zig",
  "https://zig.karearl.com/zig",
  "https://pkg.earth/zig",
  "https://fs.liujiacai.net/zigbuilds",
  "https://zigmirror.com",
  "https://zig.chainsafe.dev",
  "https://zig.savalione.com",
  "https://zig.bcr.ist",
  "https://zig.vortan.dev/zig",
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function detectPlatformAndArch() {
  const platform = {
    android: "android",
    freebsd: "freebsd",
    sunos: "illumos",
    linux: "linux",
    darwin: "macos",
    netbsd: "netbsd",
    openbsd: "openbsd",
    win32: "windows",
  }[os.platform()];
  let arch = {
    arm: "arm",
    arm64: "aarch64",
    loong64: "loongarch64",
    mips: "mips",
    mipsel: "mipsel",
    mips64: "mips64",
    mips64el: "mips64el",
    ppc64: "powerpc64",
    riscv64: "riscv64",
    s390x: "s390x",
    ia32: "x86",
    x64: "x86_64",
  }[os.arch()];
  if (!platform || !arch) {
    throw new Error(
      `Unsupported runner platform: ${os.platform()} ${os.arch()}`,
    );
  }
  if (arch === "powerpc64" && os.endianness() === "LE") arch = "powerpc64le";
  return { platform, arch };
}

async function fetchResponse(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return response;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function fetchJson(url) {
  return await (await fetchResponse(url)).json();
}

async function resolveVersion(versionInput) {
  let requested = versionInput.trim();
  if (!requested) {
    const manifestPath = core.getInput("version-file") || "build.zig.zon";
    try {
      const manifest = parse(await fs.readFile(manifestPath, "utf8"), {
        enumLiteral: "string",
      });
      requested = String(
        manifest.mach_zig_version || manifest.minimum_zig_version || "",
      );
      if (requested) {
        core.info(`Using Zig version '${requested}' from ${manifestPath}`);
      } else {core.info(
          `${manifestPath} has no minimum_zig_version; using latest stable`,
        );}
    } catch (error) {
      if (error?.code === "ENOENT") {
        core.info(`${manifestPath} was not found; using latest stable`);
      } else {
        throw new Error(
          `Could not parse ${manifestPath} for automatic version detection: ${
            errorMessage(error)
          }`,
        );
      }
    }
  }
  requested ||= "latest";

  if (requested === "master" || requested === "dev") {
    const index = await fetchJson(VERSIONS_JSON);
    return {
      requested: "master",
      version: validateResolvedVersion(index.master.version),
      index,
    };
  }
  if (requested === "latest") {
    const index = await fetchJson(VERSIONS_JSON);
    const version = latestStableVersion(index);
    return { requested: version, version, index };
  }
  if (requested.includes("mach")) {
    const index = await fetchJson(MACH_VERSIONS_JSON);
    if (!Object.hasOwn(index, requested)) {
      throw new Error(`Mach nominated version '${requested}' was not found`);
    }
    return {
      requested,
      version: validateResolvedVersion(index[requested].version),
      index: null,
    };
  }
  return {
    requested,
    version: validateResolvedVersion(requested),
    index: null,
  };
}

function withSource(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("source", SOURCE_QUERY);
  return parsed.href;
}

async function downloadFromMirror(mirror, filename, expectedSha256) {
  const archiveUrl = `${mirror}/${filename}`;
  core.info(`Downloading ${archiveUrl}`);
  const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
  const archiveDirectory = await fs.mkdtemp(
    path.join(tempRoot, "setup-zig-download-"),
  );
  const archivePath = path.join(archiveDirectory, filename);
  try {
    const response = await fetchResponse(
      withSource(archiveUrl),
      ARCHIVE_DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.body) throw new Error(`No response body from ${archiveUrl}`);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(archivePath),
    );

    const signature = Buffer.from(
      await (await fetchResponse(withSource(`${archiveUrl}.minisig`)))
        .arrayBuffer(),
    );
    const archive = await fs.readFile(archivePath);
    if (expectedSha256) {
      const actualSha256 = crypto.createHash("sha256").update(archive).digest(
        "hex",
      );
      if (actualSha256 !== expectedSha256) {
        throw new Error(`SHA-256 verification failed for ${archiveUrl}`);
      }
    }
    const publicKey = await parseKey(MINISIGN_KEY);
    const parsedSignature = parseSignature(signature);
    if (!(await verifySignature(publicKey, parsedSignature, archive))) {
      throw new Error(`Minisign verification failed for ${archiveUrl}`);
    }
    const match = /^timestamp:\d+\s+file:([^\s]+)\s+hashed$/.exec(
      parsedSignature.trusted_comment.toString(),
    );
    if (!match || match[1] !== filename) {
      throw new Error(
        `The signed filename did not match '${filename}' for ${archiveUrl}`,
      );
    }
    return { archivePath, archiveDirectory };
  } catch (error) {
    await fs.rm(archiveDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function communityMirrors() {
  try {
    const mirrors = parseMirrorList(
      await (await fetchResponse(MIRRORS_URL)).text(),
    );
    if (mirrors.length > 0) return mirrors;
    throw new Error("the mirror list was empty");
  } catch (error) {
    core.warning(
      `Could not refresh the Zig mirror list; using the bundled fallback list: ${
        errorMessage(error)
      }`,
    );
    return FALLBACK_MIRRORS;
  }
}

async function downloadArchive(version, filename, expectedSha256) {
  const override = core.getInput("mirror").trim();
  if (override) {
    return await downloadFromMirror(
      validateMirrorUrl(override),
      filename,
      expectedSha256,
    );
  }

  const errors = [];
  const mirrors = shuffle(await communityMirrors()).slice(
    0,
    MAX_MIRROR_ATTEMPTS,
  );
  for (const mirror of mirrors) {
    try {
      return await downloadFromMirror(mirror, filename, expectedSha256);
    } catch (error) {
      errors.push(`${mirror}: ${errorMessage(error)}`);
      core.info(`Mirror failed (${mirror}): ${errorMessage(error)}`);
    }
  }
  const official = version.includes("-dev")
    ? `${ZIGLANG_ORG}/builds`
    : `${ZIGLANG_ORG}/download/${version}`;
  core.warning(
    `All ${errors.length} community mirrors failed; trying ziglang.org`,
  );
  return await downloadFromMirror(official, filename, expectedSha256);
}

async function findExtractedToolchain(extractRoot, binaryName) {
  if (await fileExists(path.join(extractRoot, binaryName))) return extractRoot;
  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(extractRoot, entry.name);
      if (await fileExists(path.join(candidate, binaryName))) return candidate;
    }
  }
  throw new Error(`The Zig archive did not contain ${binaryName}`);
}

async function markerMatches(installDir, expected, binaryName) {
  try {
    const marker = JSON.parse(await fs.readFile(
      path.join(installDir, ".setup-zig.json"),
      "utf8",
    ));
    if (
      !Object.entries(expected).every(([key, value]) => marker[key] === value) ||
      typeof marker.binary_sha256 !== "string" ||
      !SHA256_RE.test(marker.binary_sha256)
    ) return false;
    return marker.binary_sha256 === await sha256File(
      path.join(installDir, binaryName),
    );
  } catch {
    return false;
  }
}

async function installToolchain(
  { platform, arch, version, filename, useCache, expectedSha256 },
) {
  const binaryName = platform === "windows" ? "zig.exe" : "zig";
  const tempRoot = process.env.RUNNER_TEMP || os.tmpdir();
  const installDir = path.join(
    tempRoot,
    "setup-zig",
    safeKeySegment(version),
    `${arch}-${platform}`,
  );
  const marker = { version, platform, arch, filename };
  const cacheKey = toolchainCacheKey(platform, arch, version);
  let cacheHit = false;

  if (useCache) {
    try {
      const restored = await cache.restoreCache([installDir], cacheKey);
      cacheHit = Boolean(restored) && await markerMatches(
        installDir,
        marker,
        binaryName,
      );
      if (restored && !cacheHit) {
        core.warning("Ignoring an invalid toolchain cache entry");
      }
    } catch (error) {
      core.warning(
        `Could not restore the toolchain cache: ${errorMessage(error)}`,
      );
    }
  }

  if (!cacheHit) {
    await fs.rm(installDir, { recursive: true, force: true });
    const { archivePath, archiveDirectory } = await downloadArchive(
      version,
      filename,
      expectedSha256,
    );
    const extractRoot = await fs.mkdtemp(
      path.join(tempRoot, "setup-zig-extract-"),
    );
    try {
      core.info(`Extracting ${filename}`);
      if (platform === "windows") await tc.extractZip(archivePath, extractRoot);
      else await tc.extractTar(archivePath, extractRoot, "xJ");
      const extracted = await findExtractedToolchain(extractRoot, binaryName);
      await fs.mkdir(path.dirname(installDir), { recursive: true });
      await fs.rename(extracted, installDir);
      await fs.writeFile(
        path.join(installDir, ".setup-zig.json"),
        JSON.stringify({
          ...marker,
          binary_sha256: await sha256File(path.join(installDir, binaryName)),
        }),
        "utf8",
      );
    } finally {
      await fs.rm(extractRoot, { recursive: true, force: true });
      await fs.rm(archiveDirectory, { recursive: true, force: true });
    }
    if (useCache) {
      try {
        await cache.saveCache([installDir], cacheKey);
      } catch (error) {
        const message = errorMessage(error);
        if (!message.includes("already exists")) {
          core.warning(`Could not save the toolchain cache: ${message}`);
        }
      }
    }
  } else {
    core.info(`Restored Zig ${version} from the toolchain cache`);
  }
  return {
    installDir,
    binaryPath: path.join(installDir, binaryName),
    cacheHit,
  };
}

async function restoreBuildCache({ platform, arch, version, zigEnvironment }) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const globalCacheDir = zigEnvironment.global_cache_dir;
  if (typeof globalCacheDir !== "string" || !globalCacheDir) {
    throw new Error("zig env did not report global_cache_dir");
  }
  const localCacheDir = process.env.ZIG_LOCAL_CACHE_DIR ||
    path.join(workspace, ".zig-cache");
  core.exportVariable("ZIG_LOCAL_CACHE_DIR", localCacheDir);

  const extraPaths = lines(core.getInput("cache-path"));
  const cachePaths = [
    ...new Set([globalCacheDir, localCacheDir, ...extraPaths]),
  ];
  for (
    const cachePath of [
      globalCacheDir,
      localCacheDir,
      ...extraPaths.filter((item) => !/[?*\[]/.test(item)),
    ]
  ) {
    await fs.mkdir(path.resolve(workspace, cachePath), { recursive: true });
  }

  const dependencyPatterns = [
    core.getInput("cache-dependency-path"),
    core.getInput("version-file"),
  ].filter(Boolean).join("\n");
  const dependencyHash = await hashDependencyFiles(dependencyPatterns, glob);
  const { key, restoreKeys } = buildCacheKey({
    platform,
    arch,
    version,
    target: zigEnvironment.target,
    userKey: core.getInput("cache-key"),
    dependencyHash,
  });
  let restoredKey = "";
  try {
    restoredKey = await cache.restoreCache(cachePaths, key, restoreKeys) || "";
    core.info(
      restoredKey
        ? `Restored Zig build cache '${restoredKey}'`
        : "Zig build cache miss",
    );
  } catch (error) {
    core.warning(
      `Could not restore the Zig build cache: ${errorMessage(error)}`,
    );
  }
  core.saveState("build-cache-key", key);
  core.saveState("build-cache-paths", JSON.stringify(cachePaths));
  core.saveState("restored-cache-key", restoredKey);
  return Boolean(restoredKey);
}

async function main() {
  try {
    const { platform, arch } = detectPlatformAndArch();
    const { requested, version, index } = await resolveVersion(
      core.getInput("version"),
    );
    const minimumVersion = core.getInput("minimum-version").trim();
    if (minimumVersion) assertMinimumVersion(version, minimumVersion);
    const filename = getTarballFilename(version, arch, platform);
    const metadataKey = `${arch}-${platform}`;
    const metadata = index?.[requested]?.[metadataKey];
    if (metadata?.tarball) {
      const indexedFilename = path.basename(
        new URL(metadata.tarball).pathname,
      );
      if (indexedFilename !== filename) {
        throw new Error(
          `Archive name mismatch in Zig's download index: ${indexedFilename}`,
        );
      }
    }
    const expectedSha256 = metadata?.shasum;
    if (expectedSha256 && !SHA256_RE.test(expectedSha256)) {
      throw new Error("Zig's download index contained an invalid SHA-256");
    }

    const useCache = core.getBooleanInput("cache");
    const useToolchainCache = useCache &&
      core.getBooleanInput("cache-toolchain");
    const installed = await installToolchain({
      platform,
      arch,
      version,
      filename,
      useCache: useToolchainCache,
      expectedSha256,
    });
    core.addPath(installed.installDir);

    const versionResult = await exec.getExecOutput(installed.binaryPath, [
      "version",
    ], { silent: true });
    const installedVersion = versionResult.stdout.trim();
    if (installedVersion !== version) {
      throw new Error(
        `Installed Zig reported version '${installedVersion}', expected '${version}'`,
      );
    }
    const envResult = await exec.getExecOutput(installed.binaryPath, ["env"], {
      silent: true,
    });
    let zigEnvironment;
    try {
      zigEnvironment = JSON.parse(envResult.stdout);
    } catch {
      zigEnvironment = parse(envResult.stdout, { enumLiteral: "string" });
    }
    core.info(`Installed Zig ${installedVersion} at ${installed.installDir}`);

    let buildCacheHit = false;
    if (useCache) {
      buildCacheHit = await restoreBuildCache({
        platform,
        arch,
        version: installedVersion,
        zigEnvironment,
      });
    }

    core.setOutput("version", installedVersion);
    core.setOutput("path", installed.installDir);
    core.setOutput("cache-hit", String(buildCacheHit));
    core.setOutput("toolchain-cache-hit", String(installed.cacheHit));
  } catch (error) {
    core.setFailed(errorMessage(error));
  }
}

await main();
