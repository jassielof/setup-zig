# Setup Zig Action

Fast, cross-platform Zig installer for GitHub Actions with smart caching.

## Features

- Fast installs (Python-based, no jq/curl chains)
- Cross-platform (Linux, macOS, Windows)
- Smart caching of `.zig-cache` and `zig-out`
- Target-aware cache keys

## Usage

```yaml
- name: Setup Zig
  uses: jassielof/setup-zig@main
```

## Inputs

| Name                  | Description                               |
| --------------------- | ----------------------------------------- |
| version               | Zig version (`latest`, `master`, `0.x.x`) |
| cache                 | Enable caching                            |
| cache-dependency-path | Files affecting cache                     |
| cache-path            | Paths to cache                            |
| target                | Target triple                             |

