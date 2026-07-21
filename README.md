# setup-zig

A GitHub Action that installs Zig on Linux, macOS, and Windows, verifies the
download, and caches both the toolchain and Zig build data.

## Usage

Check out the repository before running the action. This lets it read
`build.zig.zon` and build a project-specific cache key.

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: jassielof/setup-zig@v1
  - run: zig build test
```

When `version` is omitted, the action uses `mach_zig_version` or
`minimum_zig_version` from `build.zig.zon`. If neither is available, it installs
the latest stable release. Pin a version when you want the workflow to be fully
reproducible; use `latest` or `master` explicitly when testing compatibility.

```yaml
- uses: jassielof/setup-zig@v1
  with:
    version: 0.15.2 # also accepts latest, master, or a full dev version
```

For a matrix whose build settings are not represented by `build.zig` or
`build.zig.zon`, separate the caches with `cache-key`:

```yaml
- uses: jassielof/setup-zig@v1
  with:
    version: 0.15.2
    cache-key: ${{ matrix.target }}-${{ matrix.optimize }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | manifest or `latest` | A release, full development version, `latest`, `master`, or Mach nominated version. |
| `version-file` | `build.zig.zon` | Manifest used for automatic version detection. |
| `mirror` | community mirror list | An HTTPS mirror override. When set, no other host is tried. |
| `cache` | `true` | Cache the toolchain and Zig build data. |
| `cache-toolchain` | `true` | Cache the extracted toolchain. Has no effect when `cache` is false. |
| `cache-key` | empty | Extra cache discriminator for target, optimization mode, or other build settings. |
| `cache-dependency-path` | `build.zig` and `build.zig.zon` | Newline-separated globs hashed into the build-cache key. |
| `cache-path` | empty | Additional newline-separated cache paths or globs. |
| `cache-size-limit` | `2048` | Skip the build-cache upload above this size in MiB. Set to `0` for no limit. |

The action exposes `version`, `path`, `cache-hit`, and `toolchain-cache-hit`
outputs.

## Caching

There are two independent cache entries:

- The extracted toolchain is keyed by runner platform, architecture, and exact
  Zig version. A hit avoids both downloading and extracting Zig.
- Build data includes the `global_cache_dir` reported by `zig env`, the project
  local cache, and any `cache-path` entries. Its key also includes the exact Zig
  version, dependency-file hash, and `cache-key`.

The action sets `ZIG_LOCAL_CACHE_DIR` to `.zig-cache` in the workspace unless it
is already set. It does not cache `zig-out` by default: that directory is build
output, not Zig's incremental cache. Add it through `cache-path` only when a
workflow specifically needs it.

### Zig 0.16 and `zig-pkg`

Zig 0.16 expands fetched dependencies into a `zig-pkg` directory next to the
project's `build.zig`. It also stores each filtered package as a canonical
`$GLOBAL_ZIG_CACHE/p/$HASH.tar.gz`, which Zig can use to recreate `zig-pkg`
without another network request.

The action caches those canonical global-cache archives, but does not cache the
expanded `zig-pkg` directory by default. Caching both would duplicate package
data, increase cache transfer and extraction work, and could restore dependency
sources that a previous CI step intentionally modified. The default therefore
avoids package downloads while leaving Zig responsible for materializing a
clean project-local dependency tree.

To preserve the expanded tree as well, opt in through `cache-path`:

```yaml
- uses: jassielof/setup-zig@v1
  with:
    cache-path: zig-pkg
```

For a monorepo, list each build root explicitly rather than using a repository-
wide recursive glob:

```yaml
cache-path: |-
  packages/client/zig-pkg
  packages/server/zig-pkg
```

Cache restore and upload failures are warnings and do not fail a successful
build. Build caches are uploaded only after a successful job and are not deleted
when they exceed `cache-size-limit`.

To disable caching entirely:

```yaml
- uses: jassielof/setup-zig@v1
  with:
    cache: false
```

## Downloads and verification

By default, the action fetches Zig's current
[community mirror list](https://ziglang.org/download/community-mirrors.txt),
tries mirrors in randomized order, and uses ziglang.org only if every mirror
fails. A bundled copy of the list covers outages of ziglang.org.

Every downloaded archive is verified against the Zig Software Foundation's
minisign public key. The signed filename is checked as well, which prevents a
mirror from substituting a different signed Zig archive. See Zig's
[community mirror guidance](https://ziglang.org/download/community-mirrors/)
for the security requirements.

## Development

The committed `dist/` files are produced with Vercel ncc because JavaScript
actions run from checked-in bundled code.

```sh
pnpm test
pnpm run check
pnpm run build
```

`modules/zon-ts` contains the Deno ZON parser used to read `build.zig.zon` and
`zig env`. The build first packages it for Node, then bundles the main and post
action entry points.

## License

[MPL-2.0](LICENSE.txt)
