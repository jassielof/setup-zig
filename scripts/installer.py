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
from typing import Optional, Tuple

ZIG_INDEX = "https://ziglang.org/download/index.json"
TOOLCHAIN_MARKER = ".setup-zig-toolchain-marker"
LOG_PREFIX = "[setup-zig]"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

def detect_platform() -> Tuple[str, str]:
    os_map = {"Linux": "linux", "Darwin": "macos", "Windows": "windows"}
    arch_map = {"x86_64": "x86_64", "AMD64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}
    os_name = os_map.get(platform.system())
    arch = arch_map.get(platform.machine())
    if not os_name or not arch:
        raise RuntimeError(f"Unsupported platform: {platform.system()} {platform.machine()}")
    return os_name, arch


# ---------------------------------------------------------------------------
# Version / URL resolution
# ---------------------------------------------------------------------------

def fetch_index() -> dict:
    with urllib.request.urlopen(ZIG_INDEX) as resp:
        return json.load(resp)


def is_stable_semver(v: str) -> bool:
    return bool(re.match(r"^\d+\.\d+\.\d+$", v))


def build_stable_url(version: str, arch: str, os_name: str) -> str:
    ext = "zip" if os_name == "windows" else "tar.xz"
    return f"https://ziglang.org/download/{version}/zig-{arch}-{os_name}-{version}.{ext}"


def resolve_version_and_url(version_input: str, arch: str, os_name: str) -> Tuple[str, str]:
    """Return (resolved_version, download_url). Skips index fetch for exact semver."""
    if is_stable_semver(version_input):
        return version_input, build_stable_url(version_input, arch, os_name)

    index = fetch_index()

    if version_input in ("", "latest", None):
        versions = [v for v in index.keys() if v != "master"]
        versions.sort(key=lambda s: list(map(int, s.split("."))), reverse=True)
        version = versions[0]
    elif version_input in ("dev", "master"):
        version = "master"
    else:
        version = version_input

    key = f"{arch}-{os_name}"
    if version == "master":
        url = index["master"][key]["tarball"]
    else:
        url = index[version][key]["tarball"]
    return version, url


# ---------------------------------------------------------------------------
# Cache key / marker helpers
# ---------------------------------------------------------------------------

def toolchain_cache_key_segment(version: str, url: str) -> str:
    if version == "master":
        digest = hashlib.sha256(url.encode()).hexdigest()[:16]
        return f"master-{digest}"
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", version).strip("-")
    return safe or "unknown"


def _marker_content(version: str, url: str) -> str:
    return f"{version}\n{url}\n"


def _read_marker(install_dir: str) -> Optional[str]:
    path = os.path.join(install_dir, TOOLCHAIN_MARKER)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def _write_marker(install_dir: str, content: str) -> None:
    with open(os.path.join(install_dir, TOOLCHAIN_MARKER), "w", encoding="utf-8") as f:
        f.write(content)


# ---------------------------------------------------------------------------
# Binary helpers
# ---------------------------------------------------------------------------

def find_zig_binary(root: str) -> Optional[str]:
    # After installation the binary sits directly in the root directory.
    # Checking those two paths avoids an os.walk over ~18 000 files on Windows.
    for name in ("zig.exe", "zig"):
        candidate = os.path.join(root, name)
        if os.path.isfile(candidate):
            return candidate
    # Fallback for unusual layouts
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name in ("zig", "zig.exe"):
                return os.path.join(dirpath, name)
    return None


def add_to_path(path: str) -> None:
    github_path = os.environ.get("GITHUB_PATH")
    if github_path:
        with open(github_path, "a", encoding="utf-8") as f:
            f.write(path + "\n")
    else:
        log(f"add to PATH manually: {path}")


def zig_version_line(zig_bin: str) -> str:
    out = subprocess.run([zig_bin, "version"], check=True, capture_output=True, text=True)
    return out.stdout.strip().splitlines()[0]


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def _curl_bin() -> Optional[str]:
    return shutil.which("curl") or (shutil.which("curl.exe") if sys.platform == "win32" else None)


def _download(url: str, dest: str) -> None:
    """Download url to dest with progress, using urllib (no subprocess overhead)."""
    with urllib.request.urlopen(url) as resp, open(dest, "wb") as f:
        total_n = resp.headers.get("Content-Length")
        total_n = int(total_n) if total_n and total_n.isdigit() else None
        read_n = 0
        chunk = 1 << 20  # 1 MiB
        next_pct = 0
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            f.write(buf)
            read_n += len(buf)
            if total_n:
                pct = int(100 * read_n / total_n)
                if pct >= next_pct:
                    log(f"download {pct}% ({read_n >> 20} / {max(1, total_n >> 20)} MiB)")
                    next_pct = min(100, pct + 25)


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

def _extract_fallback(archive: str, dest: str) -> None:
    """Pure-Python fallback (slow for large .tar.xz / .zip)."""
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
        return
    abs_dest = os.path.abspath(dest)
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            mp = os.path.abspath(os.path.join(dest, member.name))
            if os.path.commonpath([abs_dest, mp]) != abs_dest:
                raise RuntimeError(f"Unsafe path in archive: {member.name}")
        t.extractall(dest)


def _extract(archive: str, dest: str, os_name: str) -> None:
    """Extract using the fastest available tool."""
    if archive.endswith(".tar.xz"):
        tar_bin = shutil.which("tar")
        if tar_bin:
            subprocess.run([tar_bin, "-xJf", archive, "-C", dest], check=True)
            return
    elif archive.endswith(".zip"):
        # Windows 10+ ships bsdtar which supports zip and is faster than
        # spawning 7-Zip (no subprocess startup overhead, streams directly).
        tar_bin = shutil.which("tar")
        if tar_bin:
            r = subprocess.run(
                [tar_bin, "-xf", archive, "-C", dest],
                capture_output=True,
            )
            if r.returncode == 0:
                return
            # bsdtar failed (shouldn't happen on modern Windows) – fall through

        # 7-Zip: suppress all diagnostic output so it doesn't pollute the log
        seven_z = shutil.which("7z") or r"C:\Program Files\7-Zip\7z.exe"
        if os.path.isfile(str(seven_z)):
            subprocess.run(
                [str(seven_z), "x", archive, f"-o{dest}", "-y", "-bso0", "-bse0", "-bsp0"],
                check=True,
            )
            return

        # PowerShell fallback
        ps = shutil.which("pwsh") or shutil.which("powershell")
        if ps:
            cmd = (
                f"Expand-Archive -LiteralPath '{archive}' "
                f"-DestinationPath '{dest}' -Force"
            )
            subprocess.run(
                [ps, "-NoProfile", "-NonInteractive", "-Command", cmd],
                check=True,
            )
            return
    _extract_fallback(archive, dest)


def _find_extracted_dir(dest: str) -> str:
    entries = [os.path.join(dest, name) for name in os.listdir(dest)]
    dirs = [p for p in entries if os.path.isdir(p)]
    if len(dirs) == 1:
        return dirs[0]
    for p in dirs:
        if os.path.exists(os.path.join(p, "zig")) or os.path.exists(os.path.join(p, "zig.exe")):
            return p
    if not dirs:
        raise RuntimeError("No directory found in extracted archive")
    return dest


# ---------------------------------------------------------------------------
# Install strategies
# ---------------------------------------------------------------------------

def _try_streaming_install(url: str, install_dir: str, os_name: str) -> bool:
    """Stream curl → tar directly into install_dir (Linux/macOS, no temp file)."""
    if os_name == "windows":
        return False
    curl = _curl_bin()
    tar_bin = shutil.which("tar")
    if not curl or not tar_bin:
        return False

    if os.path.exists(install_dir):
        shutil.rmtree(install_dir)
    os.makedirs(install_dir, exist_ok=True)

    curl_proc = subprocess.Popen(
        [curl, "-sL", "--fail", "--retry", "3", url],
        stdout=subprocess.PIPE,
    )
    tar_proc = subprocess.Popen(
        [tar_bin, "-xJ", "--strip-components=1", "-C", install_dir],
        stdin=curl_proc.stdout,
    )
    if curl_proc.stdout:
        curl_proc.stdout.close()
    tar_rc = tar_proc.wait()
    curl_rc = curl_proc.wait()

    if curl_rc != 0 or tar_rc != 0:
        log(f"streaming install failed (curl={curl_rc} tar={tar_rc}), retrying with temp file")
        shutil.rmtree(install_dir, ignore_errors=True)
        return False
    return True


def _download_and_install(url: str, install_dir: str, os_name: str) -> None:
    """Download to a temp file, extract, move to install_dir."""
    ext = ".zip" if os_name == "windows" else ".tar.xz"
    with tempfile.TemporaryDirectory() as tmp:
        archive = os.path.join(tmp, f"zig{ext}")
        extract_dir = os.path.join(tmp, "extract")
        os.makedirs(extract_dir)

        _download(url, archive)
        log("extracting…")
        _extract(archive, extract_dir, os_name)

        extracted = _find_extracted_dir(extract_dir)
        if os.path.exists(install_dir):
            shutil.rmtree(install_dir)
        shutil.move(extracted, install_dir)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="latest")
    parser.add_argument(
        "--print-toolchain-cache-key",
        action="store_true",
        help=(
            "Print two lines on stdout: <cache-key-segment>\\n<resolved-version>, then exit. "
            "No installation is performed."
        ),
    )
    args = parser.parse_args()

    os_name, arch = detect_platform()
    version, url = resolve_version_and_url(args.version, arch, os_name)

    if args.print_toolchain_cache_key:
        print(toolchain_cache_key_segment(version, url))
        print(version)
        return

    install_dir = os.path.join(os.path.expanduser("~"), ".zig")
    marker = _marker_content(version, url)

    # Toolchain cache hit: ~/.zig was restored by actions/cache; skip download.
    zig_bin = find_zig_binary(install_dir) if _read_marker(install_dir) == marker else None
    if zig_bin:
        add_to_path(os.path.dirname(zig_bin))
        log(f"toolchain already installed ({zig_version_line(zig_bin)}), skipping download")
        return

    log(f"installing Zig {version} ({arch}-{os_name})")
    log(f"fetching {url}")

    # Streaming is fastest on Linux/macOS (overlaps download + decompression).
    if not _try_streaming_install(url, install_dir, os_name):
        _download_and_install(url, install_dir, os_name)

    zig_bin = find_zig_binary(install_dir)
    if not zig_bin:
        raise RuntimeError("Zig binary not found after installation")

    _write_marker(install_dir, marker)
    add_to_path(os.path.dirname(zig_bin))
    log(f"ready: {zig_version_line(zig_bin)}")


if __name__ == "__main__":
    main()
