"""Build a private Desktop exporter and seal its exact collector input."""

import argparse
from contextlib import ExitStack
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import runpy
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent
BRIDGE = ROOT / "collect-archived.py"
original = runpy.run_path(str(BRIDGE))
anchored = original["anchored"]
owned_fd = original["owned_fd"]
read_regular = original["read_regular"]
READ = original["READ"]
NONCE = re.compile(r"[a-f0-9]{32}", re.ASCII)
DIGEST = re.compile(r"[a-f0-9]{64}", re.ASCII)
GROUPS = ("metadata", "field", "characters", "segments", "alias", "collection", "resolve")


class Refusal(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_KEY")
        result[key] = value
    return result


def invalid_constant(_value):
    raise Refusal("INVALID_JSON")


def decode(data):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise Refusal("INVALID_JSON") from error


def encode(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode()


def keys(value, expected):
    return type(value) is dict and value.keys() == set(expected)


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def parse_capture(wire, nonce, source=None):
    require(0 < len(wire) <= 163840 and wire.count(b"\n") == 2 and wire.endswith(b"\n")
            and b"\r" not in wire and not wire.startswith(b"\xef\xbb\xbf"), "INVALID_FRAMING")
    first, second, _ = wire.split(b"\n")
    require(len(first) < 1536 and len(second) < 162304, "LINE_LIMIT")
    header = decode(first)
    require(keys(header, ("version", "nonce", "observations")) and type(header["version"]) is int
            and header["version"] == 1 and type(nonce) is str and NONCE.fullmatch(nonce)
            and header["nonce"] == nonce, "HEADER_BINDING")
    observations = header["observations"]
    require(type(observations) is list and len(observations) == 2, "INCOMPLETE_TIMING")
    for position, row in enumerate(observations, 1):
        require(keys(row, ("position", "status", "elapsedMs", "groups")) and
                type(row["position"]) is int and row["position"] == position and row["status"] == "PASS"
                and integer(row["elapsedMs"], 0, 17999) and keys(row["groups"], GROUPS), "INCOMPLETE_TIMING")
        calls = duration = 0
        for group in row["groups"].values():
            require(keys(group, ("calls", "durationMs", "maxMs")) and integer(group["calls"], 1, 850)
                    and integer(group["durationMs"], 0, row["elapsedMs"])
                    and integer(group["maxMs"], 0, group["durationMs"])
                    and group["durationMs"] <= group["calls"] * group["maxMs"], "INVALID_TIMING")
            calls += group["calls"]
            duration += group["durationMs"]
        require(calls <= 850 and duration <= row["elapsedMs"], "INVALID_TIMING")
    envelope = decode(second)
    require(keys(envelope, ("before", "after")) and all(type(member) is str for member in envelope.values())
            and envelope["before"] == envelope["after"], "OBSERVATION_MISMATCH")
    try:
        member = envelope["before"].encode("utf-8")
    except UnicodeError as error:
        raise Refusal("INVALID_JSON") from error
    require(0 < len(member) <= 65536, "MEMBER_LIMIT")
    observation = decode(member)
    require(keys(observation, ("probe", "fileKey", "apiVersion", "anchorId", "cases", "dependencies", "asset"))
            and observation["probe"] == "aik.figma-closure.v1"
            and keys(observation["cases"], ("A", "B")), "INVALID_OBSERVATION")
    if source is not None:
        require(observation["fileKey"] == source["fileKey"] and observation["anchorId"] == source["anchorId"],
                "SOURCE_CHANGED")
        for letter in ("A", "B"):
            case = observation["cases"][letter]
            require(keys(case, ("root", "traversal")) and case["traversal"] == "SUBTREE"
                    and type(case["root"]) is dict and case["root"].get("id") == source["roots"][letter],
                    "SOURCE_CHANGED")
    return header, first + b"\n", second + b"\n"


def hash_bytes(contents):
    return sha256(contents).hexdigest()


def exact_file(path, digest, limit):
    require(DIGEST.fullmatch(digest), "INVALID_DIGEST")
    with ExitStack() as stack:
        parent, info = anchored(stack, str(path.parent), private=False)
        fd = owned_fd(stack, path.name, READ, parent=parent)
        data = bytes(read_regular(fd, limit, device=info.st_dev, private=False))
    require(hash_bytes(data) == digest, "INPUT_BINDING")
    return data


def write_new(stack, parent, name, data, *, rollback=None):
    fd = owned_fd(stack, name, os.O_WRONLY | os.O_EXCL | os.O_CREAT | os.O_NOFOLLOW,
                  parent=parent)
    if rollback is not None:
        rollback.callback(os.unlink, name, dir_fd=parent)
    pending = memoryview(data)
    while pending:
        count = os.write(fd, pending)
        require(count > 0, "WRITE_FAILED")
        pending = pending[count:]
    os.fsync(fd)


def monotonic_deadline(expires_at):
    remaining = expires_at - time.time_ns() // 1_000_000
    require(0 < remaining <= 300_000, "CAPTURE_EXPIRED")
    return time.monotonic_ns() + remaining * 1_000_000


def remaining_ns(expires_at, deadline):
    remaining = min(deadline - time.monotonic_ns(), expires_at * 1_000_000 - time.time_ns())
    require(remaining > 0, "CAPTURE_EXPIRED")
    return remaining


def check_time(expires_at, deadline):
    remaining_ns(expires_at, deadline)


def require_bundle_name(bundle, nonce):
    require(NONCE.fullmatch(nonce) and bundle.name in {"plugin", f"plugin-{nonce}"}, "INVALID_INVOCATION")


def prepare(args):
    from jsonschema import Draft202012Validator

    deadline = monotonic_deadline(args.expires_at)
    require_bundle_name(args.bundle, args.nonce)
    scope_bytes = exact_file(args.scope, args.scope_sha256, 32768)
    schema = decode(exact_file(args.schema, args.schema_sha256, 32768))
    scope = decode(scope_bytes)
    Draft202012Validator.check_schema(schema)
    require(Draft202012Validator(schema).is_valid(scope), "INVALID_SCOPE")
    require(NONCE.fullmatch(args.nonce) and re.fullmatch(r"[0-9]{8,32}", args.plugin_id), "INVALID_INVOCATION")
    template = {
        "name": "AIK Desktop Capture " + args.nonce, "id": args.plugin_id, "api": "1.0.0",
        "editorType": ["figma"], "main": "check.js", "ui": "ui.html", "documentAccess": "dynamic-page",
        "enablePrivatePluginApi": True, "networkAccess": {"allowedDomains": ["none"]},
    }
    getter_bytes = (ROOT / "desktop-getters.json").read_bytes()
    config = {key: scope[key] for key in ("source", "trees", "parentChains", "asset", "link", "paintBindings")}
    config["asset"] = {key: config["asset"][key] for key in ("nodeId", "fillSlot", "sourceImageId")}
    config |= {"getters": decode(getter_bytes), "nonce": args.nonce, "expiresAt": args.expires_at}
    bundle = {
        "check.js": b"const invocation = " + encode(config) + b";\n" + (ROOT / "desktop-main.js.txt").read_bytes(),
        "ui.html": (ROOT / "desktop-ui.html").read_bytes(),
        "manifest.json": encode(template) + b"\n",
    }
    binding = {name: hash_bytes(value) for name, value in bundle.items()}
    with ExitStack() as stack:
        directory, _ = anchored(stack, str(args.bundle), private=True)
        check_time(args.expires_at, deadline)
        for name, contents in bundle.items():
            write_new(stack, directory, name, contents)
        write_new(stack, directory, "invocation.json", encode({
            "schemaVersion": "aik.figma.desktop-invocation.v1", "nonce": args.nonce,
            "expiresAt": args.expires_at, "scopeSha256": args.scope_sha256, "schemaSha256": args.schema_sha256,
            "source": config["source"],
            "getterManifestSha256": hash_bytes(getter_bytes), "bundle": binding,
        }) + b"\n")
    check_time(args.expires_at, deadline)


def receive(stack, directory, basename, expires_at, deadline):
    while True:
        check_time(expires_at, deadline)
        try:
            return owned_fd(stack, basename, READ, parent=directory)
        except FileNotFoundError:
            time.sleep(0.1)


def run_bridge(args, envelope, deadline, *, env=None):
    child_deadline = min(deadline, time.monotonic_ns() + 90_000_000_000)
    child_expiry = min(args.expires_at, time.time_ns() // 1_000_000 + 90_000)
    check_time(child_expiry, child_deadline)
    with subprocess.Popen([sys.executable, "-B", str(BRIDGE), str(args.config), str(args.archive),
                           str(child_expiry)], stdin=subprocess.PIPE, start_new_session=True, env=env) as process:
        try:
            timeout = remaining_ns(child_expiry, child_deadline) / 1_000_000_000
            process.communicate(input=envelope, timeout=timeout)
        except (Refusal, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise
        check_time(child_expiry, child_deadline)
        return process.returncode


def stage_capture(stack, directory, basename, wire, transport, started):
    with ExitStack() as rollback:
        write_new(stack, directory, basename, wire, rollback=rollback)
        receipt = transport | {"monotonicIntakeMs": (time.monotonic_ns() - started) // 1_000_000}
        write_new(stack, directory, "transport.json", encode(receipt) + b"\n", rollback=rollback)
        os.fsync(directory)
        rollback.pop_all()


def seal(args):
    started = time.monotonic_ns()
    deadline = monotonic_deadline(args.expires_at)
    require_bundle_name(args.bundle, args.nonce)
    receipt = decode(exact_file(args.bundle / "invocation.json", args.invocation_sha256, 4096))
    require(receipt["schemaVersion"] == "aik.figma.desktop-invocation.v1" and receipt["nonce"] == args.nonce
            and receipt["expiresAt"] == args.expires_at and keys(receipt["bundle"], ("check.js", "ui.html", "manifest.json")),
            "INVALID_INVOCATION")
    for name, expected in receipt["bundle"].items():
        exact_file(args.bundle / name, expected, 1048576)
    basename = f"aik-capture-{args.nonce}.json"
    with ExitStack() as stack:
        directory, capture = anchored(stack, str(args.inbox), private=True)
        staging_fd, staging = anchored(stack, str(args.staging), private=True)
        _, bundle = anchored(stack, str(args.bundle), private=True)
        require(len({capture.st_dev, staging.st_dev, bundle.st_dev}) == 1
                and len({capture.st_ino, staging.st_ino, bundle.st_ino}) == 3, "UNTRUSTED_CAPTURE_ROOT")
        check_time(args.expires_at, deadline)
        fd = receive(stack, directory, basename, args.expires_at, deadline)
        wire = bytes(read_regular(fd, 163840, device=capture.st_dev, private=False))
        header, first, envelope = parse_capture(wire, args.nonce, receipt["source"])
        check_time(args.expires_at, deadline)
        stage_capture(stack, staging_fd, basename, wire, {
            "schemaVersion": "aik.figma.desktop-transport.v1", "invocationSha256": args.invocation_sha256,
            "sealedSha256": hash_bytes(wire), "headerSha256": hash_bytes(first), "stdinSha256": hash_bytes(envelope),
            "bytes": len(wire), "timing": header["observations"], "expiresAt": args.expires_at,
        }, started)
    return run_bridge(args, envelope, deadline)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.set_defaults(operation=prepare)
    seal_parser = commands.add_parser("seal")
    seal_parser.set_defaults(operation=seal)
    for command in (prepare_parser, seal_parser):
        command.add_argument("--bundle", type=Path, required=True)
        command.add_argument("--nonce", required=True)
        command.add_argument("--expires-at", type=int, required=True, help="Absolute Unix time in milliseconds")
    for name in ("scope", "schema"):
        prepare_parser.add_argument(f"--{name}", type=Path, required=True)
        prepare_parser.add_argument(f"--{name}-sha256", required=True)
    prepare_parser.add_argument("--plugin-id", required=True)
    for name in ("inbox", "staging", "config", "archive"):
        seal_parser.add_argument(f"--{name}", type=Path, required=True)
    seal_parser.add_argument("--invocation-sha256", required=True)
    args = parser.parse_args()
    try:
        return args.operation(args)
    except Refusal as error:
        print(json.dumps({"status": "REFUSED", "code": str(error)}))
    except (OSError, KeyError, ValueError, TypeError, original["Refusal"], subprocess.TimeoutExpired):
        print(json.dumps({"status": "REFUSED", "code": "DESKTOP_CAPTURE_FAILED"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
