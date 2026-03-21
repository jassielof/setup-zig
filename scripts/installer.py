#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from typing import Optional

ZIG_INDEX = "https://ziglang.org/download/index.json"
TOOLCHAIN_MARKER = ".setup-zig-toolchain-marker"
LOG_PREFIX = "[setup-zig]"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", file=sys.stderr)


def detect_platform():
    os_map = {
        "Linux": "linux",
        "Darwin": "macos",
        "Windows": "windows",
    }

    arch_map = {
        "x86_64": "x86_64",
        "AMD64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
    }

    os_name = os_map.get(platform.system())
    arch = arch_map.get(platform.machine())

    if not os_name or not arch:
        raise RuntimeError(
            f"Unsupported platform: {platform.system()} {platform.machine()}"
        )

    return os_name, arch


def fetch_index():
    with urllib.request.urlopen(ZIG_INDEX) as resp:
        return json.load(resp)


def resolve_version(index, version_input):
    if version_input in ("", "latest", None):
        versions = [v for v in index.keys() if v != "master"]
        versions.sort(key=lambda s: list(map(int, s.split("."))), reverse=True)
        return versions[0]

    if version_input in ("dev", "master"):
        return "master"

    return version_input


def get_download_url(index, version, arch, os_name):
    key = f"{arch}-{os_name}"

    if version == "master":
        return index["master"][key]["tarball"]
    else:
        return index[version][key]["tarball"]


def toolchain_marker(version_resolved: str, download_url: str) -> str:
    return f"{version_resolved}\n{download_url}\n"


def toolchain_cache_key_segment(version_resolved: str, download_url: str) -> str:
    if version_resolved == "master":
        digest = hashlib.sha256(download_url.encode()).hexdigest()[:16]
        return f"master-{digest}"
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", version_resolved).strip("-")
    return safe or "unknown"


def read_marker(install_dir: str) -> Optional[str]:
    path = os.path.join(install_dir, TOOLCHAIN_MARKER)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def write_marker(install_dir: str, content: str) -> None:
    path = os.path.join(install_dir, TOOLCHAIN_MARKER)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def should_skip_install(install_dir: str, marker: str) -> bool:
    existing = read_marker(install_dir)
    if existing is None or existing != marker:
        return False
    return find_zig_binary(install_dir) is not None


def download(url: str, path: str, chunk: int = 1 << 20) -> None:
    with urllib.request.urlopen(url) as resp:
        total = resp.headers.get("Content-Length")
        total_n = int(total) if total and total.isdigit() else None
        read_n = 0
        next_pct_report = 0
        next_mb_report = 5
        with open(path, "wb") as f:
            while True:
                buf = resp.read(chunk)
                if not buf:
                    break
                f.write(buf)
                read_n += len(buf)
                if total_n:
                    pct = int(100 * read_n / total_n)
                    if pct >= next_pct_report:
                        log(
                            f"download {pct}% "
                            f"({read_n // (1 << 20)} MiB / {max(1, total_n // (1 << 20))} MiB)"
                        )
                        next_pct_report = min(100, pct + 10)
                elif read_n >= next_mb_report * (1 << 20):
                    log(f"download {read_n // (1 << 20)} MiB…")
                    next_mb_report += 5


def extract(archive, dest):
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
    else:
        with tarfile.open(archive) as t:
            abs_dest = os.path.abspath(dest)

            for member in t.getmembers():
                member_path = os.path.abspath(os.path.join(dest, member.name))
                if os.path.commonpath([abs_dest, member_path]) != abs_dest:
                    raise RuntimeError(f"Unsafe path in archive: {member.name}")

            t.extractall(dest)


def find_extracted_dir(dest):
    entries = [os.path.join(dest, name) for name in os.listdir(dest)]
    dirs = [path for path in entries if os.path.isdir(path)]

    if len(dirs) == 1:
        return dirs[0]

    for path in dirs:
        if os.path.exists(os.path.join(path, "zig")) or os.path.exists(
            os.path.join(path, "zig.exe")
        ):
            return path

    if not dirs:
        raise RuntimeError("No extracted directory found in archive")

    return dest


def install(archive_dir, install_dir):
    if os.path.exists(install_dir):
        shutil.rmtree(install_dir)

    shutil.move(archive_dir, install_dir)


def add_to_path(path):
    github_path = os.environ.get("GITHUB_PATH")
    if github_path:
        with open(github_path, "a", encoding="utf-8") as f:
            f.write(path + "\n")
    else:
        log(f"add to PATH manually: {path}")


def find_zig_binary(root):
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name == "zig" or name == "zig.exe":
                return os.path.join(dirpath, name)
    return None


def zig_version_line(zig_bin: str) -> str:
    out = subprocess.run(
        [zig_bin, "version"],
        check=True,
        capture_output=True,
        text=True,
    )
    return out.stdout.strip().splitlines()[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="latest")
    parser.add_argument(
        "--print-toolchain-cache-key",
        action="store_true",
        help="Print only the toolchain cache key segment (stdout, no other output).",
    )
    args = parser.parse_args()

    os_name, arch = detect_platform()
    index = fetch_index()
    version = resolve_version(index, args.version)
    url = get_download_url(index, version, arch, os_name)
    marker = toolchain_marker(version, url)
    key_seg = toolchain_cache_key_segment(version, url)

    if args.print_toolchain_cache_key:
        print(key_seg, end="")
        return

    install_dir = os.path.join(os.path.expanduser("~"), ".zig")

    if should_skip_install(install_dir, marker):
        zig_bin = find_zig_binary(install_dir)
        if not zig_bin:
            raise RuntimeError("Zig binary missing despite toolchain marker")
        zig_dir = os.path.dirname(zig_bin)
        add_to_path(zig_dir)
        ver_line = zig_version_line(zig_bin)
        log(f"toolchain already installed ({ver_line}), skipping download")
        return

    with tempfile.TemporaryDirectory() as tmp:
        archive_path = os.path.join(
            tmp, "zig.tar.xz" if os_name != "windows" else "zig.zip"
        )
        extract_dir = os.path.join(tmp, "extract")
        os.mkdir(extract_dir)

        log(f"installing Zig {version} for {arch}-{os_name}")
        log(f"fetching {url}")
        download(url, archive_path)

        log("extracting archive…")
        extract(archive_path, extract_dir)

        extracted = find_extracted_dir(extract_dir)

        log(f"installing into {install_dir}")
        install(extracted, install_dir)

    zig_bin = find_zig_binary(install_dir)
    if not zig_bin:
        raise RuntimeError("Zig binary not found after installation")

    write_marker(install_dir, marker)

    zig_dir = os.path.dirname(zig_bin)
    add_to_path(zig_dir)

    ver_line = zig_version_line(zig_bin)
    log(f"ready: {ver_line}")


if __name__ == "__main__":
    main()
