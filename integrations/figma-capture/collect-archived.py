"""Pass a verified local original to the scoped collector on a private descriptor."""

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


LIMIT = 2 * 1024 * 1024
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
ORIGINAL = "A-passive-image.png"
STAGED = "a-passive-image.input"
STABLE = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_size", "st_mtime_ns", "st_ctime_ns")


class Refusal(Exception):
    pass


def owned_fd(stack, name, flags, mode=0o600, *, parent=None):
    descriptor = os.open(name, flags, mode, dir_fd=parent)
    stack.callback(os.close, descriptor)
    return descriptor


def anchored(stack, path, *, private):
    parts = path.split("/")
    if parts[0] or len(parts) < 2 or any(part in {"", ".", ".."} for part in parts[1:]):
        raise Refusal("UNTRUSTED_CAPTURE_ROOT")
    descriptor = owned_fd(stack, "/", DIRECTORY)
    for component in parts[1:]:
        descriptor = owned_fd(stack, component, DIRECTORY, parent=descriptor)
    info = os.fstat(descriptor)
    if private and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise Refusal("UNTRUSTED_CAPTURE_ROOT")
    return descriptor, info


def read_regular(descriptor, limit, *, device, private):
    before = os.fstat(descriptor)
    mode = stat.S_IMODE(before.st_mode)
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid()
            or before.st_dev != device or not 0 < before.st_size <= limit
            or (mode != 0o600 if private else bool(mode & 0o022))):
        raise Refusal("MISSING_DEPENDENCY")
    contents = bytearray()
    while len(contents) < before.st_size:
        fragment = os.read(descriptor, before.st_size - len(contents))
        if not fragment:
            raise Refusal("MISSING_DEPENDENCY")
        contents.extend(fragment)
    after = os.fstat(descriptor)
    if any(getattr(before, field) != getattr(after, field) for field in STABLE):
        raise Refusal("MISSING_DEPENDENCY")
    return contents


def verify(contents, asset):
    if (len(contents) != asset["bytes"] or hashlib.sha1(contents, usedforsecurity=False).hexdigest() != asset["sourceImageId"]
            or hashlib.sha256(contents).hexdigest() != asset["sha256"]):
        raise Refusal("MISSING_DEPENDENCY")


def remaining(deadline):
    millis = deadline - time.time_ns() // 1_000_000
    if not 0 < millis <= 90_000:
        raise Refusal("CAPTURE_FAILED")
    return millis


def run(config_path, archive_root, deadline):
    source_ref = None
    try:
        remaining(deadline)
        with ExitStack() as stack:
            config = Path(config_path)
            if config.name != "ab.json" or config.parent.name != "references":
                raise Refusal("INVALID_CAPTURE_CONFIG")
            references, ref_info = anchored(stack, str(config.parent), private=True)
            settings_fd = owned_fd(stack, config.name, READ, parent=references)
            settings = json.loads(read_regular(settings_fd, 16 * 1024, device=ref_info.st_dev, private=True))
            asset = settings["asset"]
            if not isinstance(asset["nodeId"], str) or not re.fullmatch(r"\d+:\d+", asset["nodeId"]):
                raise Refusal("INVALID_CAPTURE_CONFIG")
            source_ref = asset["nodeId"]
            if settings["group"] != "ab" or any(
                settings[key] != str(config.parent.parent / child)
                for key, child in (("captureRoot", "capture"), ("stagingRoot", "staging"))
            ):
                raise Refusal("INVALID_CAPTURE_CONFIG")
            _, capture = anchored(stack, settings["captureRoot"], private=True)
            _, staging = anchored(stack, settings["stagingRoot"], private=True)
            archive, archive_info = anchored(stack, archive_root, private=False)
            if (len({ref_info.st_dev, capture.st_dev, staging.st_dev}) != 1 or
                    len({ref_info.st_ino, capture.st_ino, staging.st_ino}) != 3):
                raise Refusal("UNTRUSTED_CAPTURE_ROOT")
            original_fd = owned_fd(stack, ORIGINAL, READ, parent=archive)
            contents = read_regular(original_fd, LIMIT, device=archive_info.st_dev, private=False)
            verify(contents, asset)
            remaining(deadline)
            with ExitStack() as staged_file:
                writer = owned_fd(staged_file, STAGED, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                  parent=references)
                stack.callback(os.unlink, STAGED, dir_fd=references)
                if stat.S_IMODE(os.fstat(writer).st_mode) != 0o600:
                    raise Refusal("MISSING_DEPENDENCY")
                pending = memoryview(contents)
                while pending:
                    count = os.write(writer, pending)
                    if count <= 0:
                        raise Refusal("MISSING_DEPENDENCY")
                    pending = pending[count:]
            staged_fd = owned_fd(stack, STAGED, READ, parent=references)
            verify(read_regular(staged_fd, LIMIT, device=ref_info.st_dev, private=True), asset)
            timeout = remaining(deadline) / 1000 + 3
            entry = Path(__file__).resolve().parent / "src" / "collect-stdin.ts"
            return subprocess.run(["node", str(entry), config_path, str(deadline),
                                   "--archived-original-fd", str(staged_fd)], pass_fds=(staged_fd,),
                                  timeout=timeout, check=False).returncode
    except (OSError, ValueError, KeyError, TypeError, Refusal, subprocess.TimeoutExpired) as error:
        diagnostic = error.args[0] if isinstance(error, Refusal) else "CAPTURE_FAILED"
        print(json.dumps({"status": "REFUSED", "diagnostic": {
            "code": diagnostic, "severity": "error", "sourceRef": source_ref,
        }}), flush=True)
        return 1


if __name__ == "__main__":
    if len(sys.argv) != 4 or not sys.argv[3].isascii() or not sys.argv[3].isdigit():
        sys.exit(2)
    sys.exit(run(sys.argv[1], sys.argv[2], int(sys.argv[3])))
