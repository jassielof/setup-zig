#!/usr/bin/env python3

import argparse
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ZIG_INDEX = "https://ziglang.org/download/index.json"


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


def download(url, path):
    with urllib.request.urlopen(url) as resp, open(path, "wb") as f:
        shutil.copyfileobj(resp, f)


def extract(archive, dest):
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
    else:
        with tarfile.open(archive) as t:
            t.extractall(dest)


def find_extracted_dir(dest):
    entries = os.listdir(dest)
    if len(entries) == 1:
        return os.path.join(dest, entries[0])
    return dest


def install(archive_dir, install_dir):
    if os.path.exists(install_dir):
        shutil.rmtree(install_dir)

    shutil.move(archive_dir, install_dir)


def add_to_path(path):
    github_path = os.environ.get("GITHUB_PATH")
    if github_path:
        with open(github_path, "a") as f:
            f.write(path + "\n")
    else:
        print(f"Add to PATH manually: {path}")


def find_zig_binary(root):
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name == "zig" or name == "zig.exe":
                return os.path.join(dirpath, name)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="latest")
    args = parser.parse_args()

    os_name, arch = detect_platform()

    index = fetch_index()
    version = resolve_version(index, args.version)
    url = get_download_url(index, version, arch, os_name)

    install_dir = os.path.join(os.path.expanduser("~"), ".zig")

    with tempfile.TemporaryDirectory() as tmp:
        archive_path = os.path.join(
            tmp, "zig.tar.xz" if os_name != "windows" else "zig.zip"
        )

        print(f"Downloading Zig {version}...")
        download(url, archive_path)

        print("Extracting...")
        extract(archive_path, tmp)

        extracted = find_extracted_dir(tmp)

        print(f"Installing to {install_dir}...")
        install(extracted, install_dir)

    zig_bin = find_zig_binary(install_dir)
    if not zig_bin:
        raise RuntimeError("Zig binary not found after installation")

    zig_dir = os.path.dirname(zig_bin)

    add_to_path(zig_dir)

    print("Zig installed:")
    subprocess.run([zig_bin, "version"], check=True)


if __name__ == "__main__":
    main()
