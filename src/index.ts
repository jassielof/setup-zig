import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import crypto from "node:crypto";
import * as core from "@actions/core";
import type * as Cache from "@actions/cache";
import { parse } from "@jassiel/zon";
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
const execFileAsync = promisify(execFile);

type CacheModule = typeof Cache;
let cacheModulePromise: Promise<CacheModule> | undefined;

function loadCache(): Promise<CacheModule> {
  cacheModulePromise ??= import("@actions/cache");
  return cacheModulePromise;
}

interface PlatformAndArch {
  platform: string;
  arch: string;
}

interface DownloadMetadata {
  tarball?: string;
  shasum?: string;
}

interface VersionMetadata extends Record<string, unknown> {
  version?: string;
}

type DownloadIndex = Record<string, VersionMetadata | undefined>;

interface ResolvedVersion {
  requested: string;
  version: string;
  index: DownloadIndex | null;
}

interface DownloadedArchive {
  archivePath: string;
  archiveDirectory: string;
}

interface InstallToolchainOptions extends PlatformAndArch {
  version: string;
  filename: string;
  useCache: boolean;
  expectedSha256: string | undefined;
  officialUrl: string;
}

interface InstalledToolchain {
  installDir: string;
  binaryPath: string;
  cacheHit: boolean;
  cacheKey: string;
  source: "cache" | "download";
}

interface RestoreBuildCacheOptions extends PlatformAndArch {
  version: string;
  runnerImage: string;
}

interface RestoredBuildCache {
  anyHit: boolean;
  exactHit: boolean;
  key: string;
  matchedKey: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectPlatformAndArch(): PlatformAndArch {
  const platforms: Partial<Record<NodeJS.Platform, string>> = {
    android: "android",
    freebsd: "freebsd",
    sunos: "illumos",
    linux: "linux",
    darwin: "macos",
    netbsd: "netbsd",
    openbsd: "openbsd",
    win32: "windows",
  };
  const architectures: Partial<Record<string, string>> = {
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
  };
  const platform = platforms[os.platform()];
  let arch = architectures[os.arch()];
  if (!platform || !arch) {
    throw new Error(
      `Unsupported runner platform: ${os.platform()} ${os.arch()}`,
    );
  }
  if (arch === "powerpc64" && os.endianness() === "LE") arch = "powerpc64le";
  return { platform, arch };
}

async function fetchResponse(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `${String(response.status)} ${response.statusText} from ${url}`,
    );
  }
  return response;
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await (await fetchResponse(url)).json()) as T;
}

async function resolveVersion(versionInput: string): Promise<ResolvedVersion> {
  let requested = versionInput.trim();
  if (!requested) {
    const versionFileInput = core.getInput("version-file");
    const manifestPath =
      versionFileInput === "" ? "build.zig.zon" : versionFileInput;
    try {
      const manifest = parse<Record<string, unknown>>(
        await fs.readFile(manifestPath, "utf8"),
        {
          enumLiteral: "string",
        },
      );
      const manifestVersion =
        manifest.mach_zig_version ?? manifest.minimum_zig_version;
      requested = typeof manifestVersion === "string" ? manifestVersion : "";
      if (requested) {
        core.info(`Using Zig version '${requested}' from ${manifestPath}`);
      } else {
        core.info(
          `${manifestPath} has no minimum_zig_version; using latest stable`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        core.info(`${manifestPath} was not found; using latest stable`);
      } else {
        throw new Error(
          `Could not parse ${manifestPath} for automatic version detection: ${errorMessage(
            error,
          )}`,
          { cause: error },
        );
      }
    }
  }
  requested ||= "latest";

  if (requested === "master" || requested === "dev") {
    const index = await fetchJson<DownloadIndex>(VERSIONS_JSON);
    const masterVersion = index.master?.version;
    if (typeof masterVersion !== "string") {
      throw new Error("Zig's download index did not contain a master version");
    }
    return {
      requested: "master",
      version: validateResolvedVersion(masterVersion),
      index,
    };
  }
  if (requested === "latest") {
    const index = await fetchJson<DownloadIndex>(VERSIONS_JSON);
    const version = latestStableVersion(index);
    return { requested: version, version, index };
  }
  if (requested.includes("mach")) {
    const index = await fetchJson<DownloadIndex>(MACH_VERSIONS_JSON);
    if (!Object.hasOwn(index, requested)) {
      throw new Error(`Mach nominated version '${requested}' was not found`);
    }
    const nominatedVersion = index[requested]?.version;
    if (typeof nominatedVersion !== "string") {
      throw new Error(`Mach nominated version '${requested}' was invalid`);
    }
    return {
      requested,
      version: validateResolvedVersion(nominatedVersion),
      index: null,
    };
  }
  return {
    requested,
    version: validateResolvedVersion(requested),
    index: null,
  };
}

function withSource(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("source", SOURCE_QUERY);
  return parsed.href;
}

async function downloadFromUrl(
  archiveUrl: string,
  filename: string,
  expectedSha256?: string,
): Promise<DownloadedArchive> {
  core.info(`Downloading ${archiveUrl}`);
  const tempRoot = process.env.RUNNER_TEMP ?? os.tmpdir();
  const archiveDirectory = await fs.mkdtemp(
    path.join(tempRoot, "setup-zig-download-"),
  );
  const archivePath = path.join(archiveDirectory, filename);
  let signaturePromise: Promise<Buffer> | undefined;
  try {
    signaturePromise = fetchResponse(withSource(`${archiveUrl}.minisig`)).then(
      async (response) => Buffer.from(await response.arrayBuffer()),
    );
    const response = await fetchResponse(
      withSource(archiveUrl),
      ARCHIVE_DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.body) throw new Error(`No response body from ${archiveUrl}`);
    const sha256 = crypto.createHash("sha256");
    const blake2b = crypto.createHash("blake2b512");
    const hashStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sha256.update(chunk);
        blake2b.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      hashStream,
      createWriteStream(archivePath),
    );

    if (expectedSha256) {
      const actualSha256 = sha256.digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(`SHA-256 verification failed for ${archiveUrl}`);
      }
    }
    const signature = await signaturePromise;
    const publicKey = await parseKey(MINISIGN_KEY);
    const parsedSignature = parseSignature(signature);
    const archive = parsedSignature.algorithm.equals(Buffer.from("Ed"))
      ? await fs.readFile(archivePath)
      : Buffer.alloc(0);
    if (
      !(await verifySignature(
        publicKey,
        parsedSignature,
        archive,
        blake2b.digest(),
      ))
    ) {
      throw new Error(`Minisign verification failed for ${archiveUrl}`);
    }
    const match = /^timestamp:\d+\s+file:([^\s]+)\s+hashed$/.exec(
      parsedSignature.trusted_comment.toString(),
    );
    if (match?.[1] !== filename) {
      throw new Error(
        `The signed filename did not match '${filename}' for ${archiveUrl}`,
      );
    }
    return { archivePath, archiveDirectory };
  } catch (error) {
    await signaturePromise?.catch(() => undefined);
    await fs.rm(archiveDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function downloadFromMirror(
  mirror: string,
  filename: string,
  expectedSha256?: string,
): Promise<DownloadedArchive> {
  return await downloadFromUrl(
    `${mirror}/${filename}`,
    filename,
    expectedSha256,
  );
}

async function communityMirrors(): Promise<string[]> {
  try {
    const mirrors = parseMirrorList(
      await (await fetchResponse(MIRRORS_URL)).text(),
    );
    if (mirrors.length > 0) return mirrors;
    throw new Error("the mirror list was empty");
  } catch (error) {
    core.warning(
      `Could not load the Zig mirror list; falling back to ziglang.org: ${errorMessage(
        error,
      )}`,
    );
    return [];
  }
}

async function downloadArchive(
  officialUrl: string,
  filename: string,
  expectedSha256?: string,
): Promise<DownloadedArchive> {
  const override = core.getInput("mirror").trim();
  if (override) {
    return await downloadFromMirror(
      validateMirrorUrl(override),
      filename,
      expectedSha256,
    );
  }

  const errors: string[] = [];
  const mirrors = (await communityMirrors()).slice(0, MAX_MIRROR_ATTEMPTS);
  for (const mirror of mirrors) {
    try {
      return await downloadFromMirror(mirror, filename, expectedSha256);
    } catch (error) {
      errors.push(`${mirror}: ${errorMessage(error)}`);
      core.info(`Mirror failed (${mirror}): ${errorMessage(error)}`);
    }
  }
  try {
    return await downloadFromUrl(officialUrl, filename, expectedSha256);
  } catch (error) {
    errors.push(`ziglang.org: ${errorMessage(error)}`);
  }
  throw new Error(`Could not download ${filename}: ${errors.join("; ")}`);
}

async function findExtractedToolchain(
  extractRoot: string,
  binaryName: string,
): Promise<string> {
  if (existsSync(path.join(extractRoot, binaryName))) return extractRoot;
  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const candidate = path.join(extractRoot, entry.name);
      if (existsSync(path.join(candidate, binaryName))) return candidate;
    }
  }
  throw new Error(`The Zig archive did not contain ${binaryName}`);
}

async function markerMatches(
  installDir: string,
  expected: Record<string, string>,
  binaryName: string,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(installDir, ".setup-zig.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      !Object.entries(expected).every(([key, value]) => marker[key] === value)
    )
      return false;
    return existsSync(path.join(installDir, binaryName));
  } catch {
    return false;
  }
}

async function installToolchain({
  platform,
  arch,
  version,
  filename,
  useCache,
  expectedSha256,
  officialUrl,
}: InstallToolchainOptions): Promise<InstalledToolchain> {
  const binaryName = platform === "windows" ? "zig.exe" : "zig";
  const tempRoot = process.env.RUNNER_TEMP ?? os.tmpdir();
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
      const cache = await loadCache();
      const restored = await cache.restoreCache([installDir], cacheKey);
      cacheHit =
        Boolean(restored) &&
        (await markerMatches(installDir, marker, binaryName));
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
      officialUrl,
      filename,
      expectedSha256,
    );
    const extractRoot = await fs.mkdtemp(
      path.join(tempRoot, "setup-zig-extract-"),
    );
    try {
      core.info(`Extracting ${filename}`);
      await execFileAsync("tar", ["-xf", archivePath, "-C", extractRoot], {
        windowsHide: true,
      });
      const extracted = await findExtractedToolchain(extractRoot, binaryName);
      await fs.mkdir(path.dirname(installDir), { recursive: true });
      await fs.rename(extracted, installDir);
      await fs.writeFile(
        path.join(installDir, ".setup-zig.json"),
        JSON.stringify(marker),
        "utf8",
      );
    } finally {
      await fs.rm(extractRoot, { recursive: true, force: true });
      await fs.rm(archiveDirectory, { recursive: true, force: true });
    }
    if (useCache) {
      core.saveState("toolchain-cache-key", cacheKey);
      core.saveState("toolchain-cache-path", installDir);
    }
  } else {
    core.info(`Restored Zig ${version} from the toolchain cache`);
  }
  return {
    installDir,
    binaryPath: path.join(installDir, binaryName),
    cacheHit,
    cacheKey,
    source: cacheHit ? "cache" : "download",
  };
}

async function restoreBuildCache({
  platform,
  arch,
  version,
  runnerImage,
}: RestoreBuildCacheOptions): Promise<RestoredBuildCache> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const tempRoot = process.env.RUNNER_TEMP ?? os.tmpdir();
  const globalCacheDir = path.join(
    tempRoot,
    "setup-zig-cache",
    safeKeySegment(version),
    `${arch}-${platform}`,
    "global",
  );
  const localCacheDir =
    process.env.ZIG_LOCAL_CACHE_DIR ?? path.join(workspace, ".zig-cache");
  core.exportVariable("ZIG_GLOBAL_CACHE_DIR", globalCacheDir);
  core.exportVariable("ZIG_LOCAL_CACHE_DIR", localCacheDir);

  const extraPaths = lines(core.getInput("cache-path"));
  const cachePaths = [
    ...new Set([globalCacheDir, localCacheDir, ...extraPaths]),
  ];
  for (const cachePath of [
    globalCacheDir,
    localCacheDir,
    ...extraPaths.filter(
      (item) =>
        !item.includes("?") && !item.includes("*") && !item.includes("["),
    ),
  ]) {
    await fs.mkdir(path.resolve(workspace, cachePath), { recursive: true });
  }

  const dependencyPatterns = [
    core.getInput("cache-dependency-path"),
    core.getInput("version-file"),
  ]
    .filter(Boolean)
    .join("\n");
  const glob = await import("@actions/glob");
  const dependencyHash = await hashDependencyFiles(dependencyPatterns, glob);
  const { key, restoreKeys } = buildCacheKey({
    platform,
    arch,
    version,
    runnerImage,
    userKey: core.getInput("cache-key"),
    dependencyHash,
  });
  let restoredKey = "";
  try {
    const cache = await loadCache();
    restoredKey =
      (await cache.restoreCache(cachePaths, key, restoreKeys)) ?? "";
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
  return {
    anyHit: restoredKey !== "",
    exactHit: restoredKey === key,
    key,
    matchedKey: restoredKey,
  };
}

async function main(): Promise<void> {
  const setupStartedAt = performance.now();
  try {
    const { platform, arch } = detectPlatformAndArch();
    const versionStartedAt = performance.now();
    const { requested, version, index } = await resolveVersion(
      core.getInput("version"),
    );
    const versionResolutionMs = performance.now() - versionStartedAt;
    const minimumVersion = core.getInput("minimum-version").trim();
    if (minimumVersion) assertMinimumVersion(version, minimumVersion);
    const filename = getTarballFilename(version, arch, platform);
    const metadataKey = `${arch}-${platform}`;
    const metadata = index?.[requested]?.[metadataKey] as
      DownloadMetadata | undefined;
    if (metadata?.tarball) {
      const indexedFilename = path.basename(new URL(metadata.tarball).pathname);
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
    const officialUrl =
      metadata?.tarball ??
      `${
        version.includes("-dev")
          ? `${ZIGLANG_ORG}/builds`
          : `${ZIGLANG_ORG}/download/${version}`
      }/${filename}`;

    const useCache = core.getBooleanInput("cache");
    const useToolchainCache =
      useCache && core.getBooleanInput("cache-toolchain");
    const useBuildCache = useCache && core.getBooleanInput("cache-build");
    const runnerImage = process.env.ImageOS ?? `${platform}-${arch}`;
    const toolchainStartedAt = performance.now();
    const installedPromise = installToolchain({
      platform,
      arch,
      version,
      filename,
      useCache: useToolchainCache,
      expectedSha256,
      officialUrl,
    }).then((installed) => ({
      installed,
      durationMs: performance.now() - toolchainStartedAt,
    }));
    const buildCacheStartedAt = performance.now();
    const buildCachePromise = useBuildCache
      ? restoreBuildCache({ platform, arch, version, runnerImage }).then(
          (result) => ({
            ...result,
            durationMs: performance.now() - buildCacheStartedAt,
          }),
        )
      : Promise.resolve({
          anyHit: false,
          exactHit: false,
          key: "",
          matchedKey: "",
          durationMs: 0,
        });
    const [{ installed, durationMs: toolchainDurationMs }, buildCache] =
      await Promise.all([installedPromise, buildCachePromise]);
    core.addPath(installed.installDir);

    const versionResult = await execFileAsync(
      installed.binaryPath,
      ["version"],
      { encoding: "utf8", windowsHide: true },
    );
    const installedVersion = versionResult.stdout.trim();
    if (installedVersion !== version) {
      throw new Error(
        `Installed Zig reported version '${installedVersion}', expected '${version}'`,
      );
    }
    core.info(`Installed Zig ${installedVersion} at ${installed.installDir}`);
    const setupDurationMs = performance.now() - setupStartedAt;

    core.setOutput("version", installedVersion);
    core.setOutput("path", installed.installDir);
    core.setOutput("cache-hit", String(buildCache.anyHit));
    core.setOutput("build-cache-hit", String(buildCache.anyHit));
    core.setOutput("build-cache-exact-hit", String(buildCache.exactHit));
    core.setOutput("build-cache-key", buildCache.key);
    core.setOutput("build-cache-matched-key", buildCache.matchedKey);
    core.setOutput("toolchain-cache-hit", String(installed.cacheHit));
    core.setOutput("toolchain-cache-key", installed.cacheKey);
    core.setOutput("toolchain-source", installed.source);
    core.setOutput("platform", platform);
    core.setOutput("arch", arch);
    core.setOutput("runner-image", runnerImage);
    const timings = {
      versionResolutionMs: Math.round(versionResolutionMs),
      toolchainMs: Math.round(toolchainDurationMs),
      buildCacheMs: Math.round(buildCache.durationMs),
      setupMs: Math.round(setupDurationMs),
    };
    core.setOutput(
      "version-resolution-ms",
      String(timings.versionResolutionMs),
    );
    core.setOutput("toolchain-ms", String(timings.toolchainMs));
    core.setOutput("build-cache-ms", String(timings.buildCacheMs));
    core.setOutput("setup-ms", String(timings.setupMs));
    core.setOutput("timings", JSON.stringify(timings));
    core.setOutput("cache-mode", process.env.ACTIONS_CACHE_MODE ?? "default");
    core.info(
      `Setup completed in ${String(timings.setupMs)} ms ` +
        `(version ${String(timings.versionResolutionMs)} ms, ` +
        `toolchain ${String(timings.toolchainMs)} ms, ` +
        `build cache ${String(timings.buildCacheMs)} ms)`,
    );
  } catch (error) {
    core.setFailed(errorMessage(error));
  }
}

await main();
