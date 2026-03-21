# setup-zig

Fast, cross-platform Zig toolchain installer for GitHub Actions with two-tier caching.

## Features

- **Streaming install on Linux and macOS** — pipes the download directly into `tar`, so decompression overlaps with the network transfer (typically 5–8 s).
- **Two-tier caching enabled by default** — the Zig toolchain (`~/.zig`) is cached separately from build artifacts (`.zig-cache`, `zig-out`), so the toolchain is restored from cache in ~3 s on subsequent runs across all platforms.
- **No index fetch for stable versions** — for an exact version like `0.15.2` the download URL is constructed directly, skipping the `ziglang.org` index request entirely.
- Cross-platform: Linux, macOS, Windows. Requires only a Python runtime on the runner.

## Usage

```yaml
- uses: jassielof/setup-zig@v1
  with:
    version: latest   # or master, or 0.15.2 — defaults to latest
```

Caching is on by default. To opt out:

```yaml
- uses: jassielof/setup-zig@v1
  with:
    version: latest
    cache: false
```

## Inputs

| Name                   | Default                          | Description |
| ---------------------- | -------------------------------- | ----------- |
| `version`              | `latest`                         | Zig version to install: `latest` (newest stable), `master` (nightly), or an exact release like `0.15.2`. |
| `cache`                | `true`                           | Enable two-tier caching (toolchain + build artifacts). |
| `cache-toolchain`      | `true`                           | Cache the Zig install under `~/.zig`. Disable if you only want build-artifact caching. |
| `cache-dependency-path`| `build.zig` / `build.zig.zon`    | Glob(s) whose content is hashed into the build cache key. Does not affect the toolchain cache key. |
| `cache-path`           | `**/.zig-cache` / `**/zig-out`   | Paths included in the build artifact cache. |
| `target`               | _(none)_                         | Zig cross-compilation target triple, used to make the build cache key target-aware. |

## How caching works

Two independent `actions/cache` entries are created per job:

| Cache | Key | What it stores |
| ----- | --- | -------------- |
| Toolchain | `zig-toolchain-{OS}-{arch}-{version}` | `~/.zig` — the full Zig installation. After a cache hit the installer skips the download entirely. |
| Build artifacts | `zig-build-{OS}-{version}-{target}-{hash}` | `.zig-cache` and `zig-out` — incremental build state. |

The toolchain cache key for `master` is derived from the tarball URL (which encodes the commit hash), so nightly builds invalidate automatically when upstream changes.
