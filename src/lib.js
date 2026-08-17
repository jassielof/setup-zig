import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import semver from "semver";

const ZIG_VERSION_RE = /^\d+\.\d+\.\d+(?:-dev\.\d+\+[0-9a-f]+)?$/i;

export function versionLessThan(current, minimum) {
  const currentVersion = semver.valid(current);
  const minimumVersion = semver.valid(minimum);
  return currentVersion !== null && minimumVersion !== null &&
    semver.lt(currentVersion, minimumVersion);
}

export function validateResolvedVersion(version) {
  if (!ZIG_VERSION_RE.test(version)) {
    throw new Error(
      `Invalid Zig version '${version}'. Expected a release such as '0.15.2' or a full development version.`,
    );
  }
  return version;
}

export function assertMinimumVersion(version, minimumVersion) {
  validateResolvedVersion(minimumVersion);
  if (versionLessThan(version, minimumVersion)) {
    throw new Error(
      `Resolved Zig version '${version}' is older than the required minimum '${minimumVersion}'`,
    );
  }
}

export function latestStableVersion(index) {
  const versions = Object.keys(index)
    .filter((version) =>
      version !== "master" && semver.valid(version) &&
      !semver.prerelease(version)
    )
    .sort(semver.rcompare);
  if (versions.length === 0) {
    throw new Error("The Zig download index did not contain a stable release");
  }
  return versions[0];
}

export function getTarballFilename(version, arch, platform) {
  validateResolvedVersion(version);
  const extension = platform === "windows" ? "zip" : "tar.xz";
  const archiveArch = arch === "arm" && versionLessThan(version, "0.15.1")
    ? "armv7a"
    : arch;
  const legacyOrder = versionLessThan(version, "0.15.0-dev.631+9a3540d61") &&
    versionLessThan(version, "0.14.1");
  const basename = legacyOrder
    ? `zig-${platform}-${archiveArch}-${version}`
    : `zig-${archiveArch}-${platform}-${version}`;
  return `${basename}.${extension}`;
}

export function parseMirrorList(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map(
    validateMirrorUrl,
  );
}

export function validateMirrorUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid mirror URL '${value}'`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash
  ) {
    throw new Error(
      "Mirror URLs must use HTTPS and cannot include credentials, a query, or a fragment",
    );
  }
  if (url.hostname === "ziglang.org") {
    throw new Error(
      "ziglang.org is already the final fallback and cannot be used as a mirror override",
    );
  }
  return url.href.replace(/\/$/, "");
}

export function shuffle(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function safeKeySegment(value, fallback = "default") {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  if (!normalized) return fallback;
  if (normalized.length <= 80) return normalized;
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(
    0,
    16,
  );
  return `${normalized.slice(0, 60)}-${digest}`;
}

export function toolchainCacheKey(platform, arch, version) {
  return `setup-zig-toolchain-v3-${safeKeySegment(platform)}-${
    safeKeySegment(arch)
  }-${safeKeySegment(version)}`;
}

export function buildCacheKey(
  { platform, arch, version, target, userKey, dependencyHash },
) {
  const prefix = `setup-zig-build-v4-${safeKeySegment(platform)}-${
    safeKeySegment(arch)
  }-${safeKeySegment(version)}-${safeKeySegment(target, "unknown-target")}-${
    safeKeySegment(userKey)
  }`;
  return { key: `${prefix}-${dependencyHash}`, restoreKeys: [`${prefix}-`] };
}

export function lines(value) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export async function hashDependencyFiles(patterns, globModule) {
  const patternList = lines(patterns);
  if (patternList.length === 0) return "default";
  const globber = await globModule.create(patternList.join("\n"));
  const files = (await globber.glob()).sort();
  const hash = crypto.createHash("sha256");
  let count = 0;
  for (const file of files) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) continue;
    count++;
    hash.update(path.resolve(file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return count === 0 ? "default" : hash.digest("hex");
}
