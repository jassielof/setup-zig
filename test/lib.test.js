import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMinimumVersion,
  buildCacheKey,
  getTarballFilename,
  latestStableVersion,
  lines,
  parseMirrorList,
  safeKeySegment,
  shuffle,
  validateMirrorUrl,
  validateResolvedVersion,
  versionLessThan,
} from "../src/lib.js";

test("selects the newest stable version", () => {
  assert.equal(
    latestStableVersion({
      master: {},
      "0.14.1": {},
      "0.15.2": {},
      "0.15.1": {},
    }),
    "0.15.2",
  );
});

test("validates release and development versions", () => {
  assert.equal(validateResolvedVersion("0.15.2"), "0.15.2");
  assert.equal(
    validateResolvedVersion("0.16.0-dev.1234+abcdef12"),
    "0.16.0-dev.1234+abcdef12",
  );
  assert.throws(
    () => validateResolvedVersion("../../zig"),
    /Invalid Zig version/,
  );
});

test("enforces an optional resolved-version floor", () => {
  assert.doesNotThrow(() => assertMinimumVersion("0.16.0", "0.15.2"));
  assert.throws(
    () => assertMinimumVersion("0.15.2", "0.16.0"),
    /older than the required minimum/,
  );
});

test("compares Zig versions and uses historical archive names", () => {
  assert.equal(versionLessThan("0.14.0", "0.14.1"), true);
  assert.equal(
    getTarballFilename("0.14.0", "x86_64", "linux"),
    "zig-linux-x86_64-0.14.0.tar.xz",
  );
  assert.equal(
    getTarballFilename("0.15.2", "x86_64", "windows"),
    "zig-x86_64-windows-0.15.2.zip",
  );
  assert.equal(
    getTarballFilename("0.14.1", "arm", "linux"),
    "zig-armv7a-linux-0.14.1.tar.xz",
  );
});

test("accepts only safe community mirror URLs", () => {
  assert.equal(
    validateMirrorUrl("https://example.com/zig/"),
    "https://example.com/zig",
  );
  assert.throws(() => validateMirrorUrl("http://example.com"), /HTTPS/);
  assert.throws(
    () => validateMirrorUrl("https://ziglang.org/download"),
    /final fallback/,
  );
  assert.deepEqual(
    parseMirrorList("https://a.example/zig\nhttps://b.example\n"),
    [
      "https://a.example/zig",
      "https://b.example",
    ],
  );
});

test("shuffle does not mutate its input", () => {
  const input = ["a", "b", "c"];
  assert.deepEqual(shuffle(input, () => 0), ["b", "c", "a"]);
  assert.deepEqual(input, ["a", "b", "c"]);
});

test("cache keys sanitize user-controlled text", () => {
  assert.equal(safeKeySegment(" linux / release "), "linux-release");
  const result = buildCacheKey({
    platform: "linux",
    arch: "x86_64",
    version: "0.15.2",
    target: "x86_64-linux.6.11...6.11-gnu.2.40",
    userKey: "Debug / native",
    dependencyHash: "abc",
  });
  assert.equal(
    result.key,
    "setup-zig-build-v4-linux-x86_64-0.15.2-x86_64-linux.6.11...6.11-gnu.2.40-Debug-native-abc",
  );
  assert.deepEqual(lines("a\r\n\n b \n"), ["a", "b"]);
});
