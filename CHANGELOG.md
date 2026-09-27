# Changelog

## [1.3.0] - 2026-09-27

### Highlights

- Reimplemented the action as a Node 24 JavaScript action written in strict
  TypeScript 6 and bundled with esbuild.
- Reduced median warm setup time from 9 seconds to 6 seconds in the release
  benchmark by restoring the toolchain and build caches concurrently.
- Added automatic version selection from `build.zig.zon`, including
  `minimum_zig_version` and Mach-nominated Zig versions.

### Added

- Inputs for `version-file`, `minimum-version`, `mirror`, `cache-build`,
  `cache-key`, and `cache-size-limit`.
- Outputs for the resolved version and path, cache keys and hit status,
  toolchain source, runner platform details, and setup timing measurements.
- Verified community-mirror downloads with automatic fallback to ziglang.org.
- A post action that uploads toolchain and build caches concurrently after a
  successful job.
- Strict TypeScript, ESLint, Prettier, unit tests, cross-platform integration
  tests, and automatic `dist` regeneration.

### Changed

- Streams archive checksums while downloading and verifies every archive with
  Zig's minisign public key before extraction.
- Uses native `tar` extraction on Linux, macOS, and Windows.
- Uses deterministic global and local Zig cache directories and keys them by
  the exact Zig version and runner image.
- Prioritizes Zig's maintained community mirror list before falling back to the
  official download host.
- Defers cache uploads to the post action so they do not delay setup.

### Migration notes

- The action now runs on Node 24. Self-hosted runners must support Node 24
  JavaScript actions.
- The previous `target` input has been replaced by the more general
  `cache-key` input. Include the target and optimization mode there when they
  affect cache compatibility.
- `cache-path` now adds paths to the built-in global and local Zig caches.
  `zig-out` is no longer cached by default.
- Build-cache keys use the new `v5` namespace. The first run after upgrading
  will populate a new cache; subsequent runs can restore it.
- `cache-size-limit` defaults to `0`, avoiding an expensive recursive size scan.

[1.3.0]: https://github.com/jassielof/setup-zig/compare/v1.2.0...v1.3.0
