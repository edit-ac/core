#!/usr/bin/env python3
"""Native suite dispatcher. Each invocation keeps its full logs and receipt."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT.parents[1]
SUITES = {
    "styles": ("EditacMacOSStylesTests.StylesTests", 12),
    "commands": ("EditacMacOSCommandsTests.CommandsTests", 36),
    "composition": ("EditacMacOSCompositionTests.CompositionTests", 22),
    "edits": ("EditacMacOSEditsTests.EditsTests", 10),
    "projection": ("EditacMacOSProjectionTests.ProjectionTests", 22),
    "bootstrap": ("EditacMacOSBootstrapTests.BootstrapTests", 1),
    "session": ("EditacMacOSSessionTests.SessionTests", 12),
    "toolkit": ("EditacMacOSToolkitTests.ToolkitTests", 6),
}


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def parse_xctest_counts(log):
    summaries = re.findall(
        r"Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?", log)
    if not summaries:
        raise ValueError("No XCTest execution summary (zero or missing matching tests)")
    executed, skipped, failed = (int(n or 0) for n in summaries[-1])
    failed_cases = len(re.findall(r"Test Case '.+' failed", log))
    return dict(executed=executed, passed=executed - skipped - failed_cases,
                failed=failed_cases, skipped=skipped, failureAssertions=failed)


def xctest_counts(log, expected):
    counts = parse_xctest_counts(log)
    executed, failed, skipped = counts["executed"], counts["failureAssertions"], counts["skipped"]
    if executed != expected or executed == 0 or failed or skipped:
        raise ValueError(f"Required XCTest count mismatch/failure/skip: {counts}; expected {expected}")
    return counts


def stop_command_tree(process):
    """Stop exact owned descendants, including XCTest's separate process group."""
    def inventory():
        rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True)
        result = {}
        for row in rows.splitlines():
            fields = row.strip().split(None, 2)
            if len(fields) == 3:
                result[int(fields[0])] = (int(fields[1]), fields[2])
        return result
    initial = inventory()
    owned = [process.pid]
    for pid in owned:
        owned.extend(child for child, (parent, _) in initial.items()
                     if parent == pid and child not in owned)
    commands = {pid: initial[pid][1] for pid in owned if pid in initial}
    def survivors():
        current = inventory()
        return [pid for pid in reversed(owned)
                if pid in commands and pid in current and current[pid][1] == commands[pid]]
    for pid in survivors():
        if pid in survivors():
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    deadline = time.monotonic() + 2
    while survivors() and time.monotonic() < deadline:
        time.sleep(0.05)
    for pid in survivors():
        if pid in survivors():
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
    process.wait(timeout=5)
    if survivors():
        raise RuntimeError("Owned command descendants survived teardown")
    return len(commands)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in SUITES:
        print("Usage: bash native/macos/scripts/check.sh {bootstrap|toolkit|session|projection|edits|composition|commands|styles}; unknown/unimplemented suite", file=sys.stderr)
        return 2
    suite = sys.argv[1]
    signal.signal(signal.SIGTERM, interrupted)
    # No caller-controlled output overwrite and no shared SwiftPM build directory.
    evidence_root = CORE / ".artifacts" / "macos"
    evidence_root.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix=f"{suite}-", dir=evidence_root))
    receipt = {"suite": suite, "state": "failed", "provenance": "macos-os-host",
               "startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "commands": [], "counts": None, "failure": None,
               "qualification": "unqualified", "sourceHashes": {}}

    def run(name, command, timeout=180):
        log = output / f"{name}.log"
        entry = {"name": name, "command": command, "log": log.name}
        receipt["commands"].append(entry)
        with log.open("w") as stream:
            process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stream,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                entry["exitCode"] = process.wait(timeout=timeout)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                entry["terminatedProcessCount"] = stop_command_tree(process)
                entry["interruptedOrTimedOut"] = True
                raise RuntimeError(f"{name} interrupted/timed out; see {log}")
        entry["sha256"] = hashlib.sha256(log.read_bytes()).hexdigest()
        if process.returncode:
            raise RuntimeError(f"{name} exited {process.returncode}; see {log}")
        return log.read_text()

    env = os.environ.copy()
    try:
        if platform.system() != "Darwin":
            raise RuntimeError("Requires macOS OS host/VM with pinned Xcode and a GUI login session")
        pin = json.loads((ROOT / "toolchain.json").read_text())
        env["MACOSX_DEPLOYMENT_TARGET"] = pin["deploymentMinimum"]
        actual = {
            "xcode": run("xcode", ["xcodebuild", "-version"]),
            "swift": run("swift", ["xcrun", "swift", "--version"]),
            "sdkVersion": run("sdk-version", ["xcrun", "--sdk", "macosx", "--show-sdk-version"]).strip(),
            "sdkBuild": run("sdk-build", ["xcrun", "--sdk", "macosx", "--show-sdk-build-version"]).strip(),
            "sdkPath": run("sdk-path", ["xcrun", "--sdk", "macosx", "--show-sdk-path"]).strip(),
            "os": run("os-version", ["sw_vers", "-productVersion"]).strip(),
            "osBuild": run("os-build", ["sw_vers", "-buildVersion"]).strip(),
            "cpu": platform.machine(),
            "node": run("node-version", ["node", "--version"]).strip(),
        }
        receipt["environment"] = actual
        env["SDKROOT"] = actual["sdkPath"]
        if actual["node"] != pin["nodeVersion"]:
            raise RuntimeError("Node pin mismatch; put Node 24.19.0 on PATH per workspace setup")
        if actual["xcode"].strip() != f"Xcode {pin['xcodeVersion']}\nBuild version {pin['xcodeBuild']}":
            raise RuntimeError("Xcode pin mismatch; install/select the toolchain in toolchain.json")
        if (f"Apple Swift version {pin['swiftVersion']} (" not in actual["swift"] or
                pin["swiftBuild"] not in actual["swift"]):
            raise RuntimeError("Swift pin mismatch; select the pinned Xcode toolchain")
        if actual["sdkVersion"] != pin["sdkVersion"] or actual["sdkBuild"] != pin["sdkBuild"]:
            raise RuntimeError("macOS SDK pin mismatch; install the pinned Xcode SDK")
        if (actual["os"], actual["osBuild"], actual["cpu"]) != (
                pin["testHost"]["os"], pin["testHost"]["build"], pin["testHost"]["cpu"]):
            raise RuntimeError("Test host pin mismatch; provision the named macOS host/VM or explicitly requalify pins")
        receipt["implementationRevision"] = run("revision", ["git", "rev-parse", "HEAD"]).strip()
        paths = sorted(p for p in ROOT.rglob("*") if p.is_file()
                       and ".build" not in p.parts and "__pycache__" not in p.parts)
        receipt["sourceHashes"] = {str(p.relative_to(CORE)): hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in paths}
        receipt["sharedSourceHashes"] = {str(p.relative_to(CORE)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [CORE / "Cargo.lock", CORE / "crates/editac-ffi/Cargo.toml",
                      *sorted((CORE / "crates/editac-ffi/src").rglob("*.rs"))]}
        capability_log = run("capability-tests", ["node", "--test", "--test-reporter=tap",
                                                "tests/capability.test.mjs"])
        capability_counts = {key: int(value) for key, value in re.findall(
            r"^# (tests|pass|fail|skipped) (\d+)$", capability_log, re.MULTILINE)}
        if capability_counts != {"tests": 2, "pass": 2, "fail": 0, "skipped": 0}:
            raise RuntimeError(f"Capability tests missing/failed/skipped: {capability_counts}")
        dispatcher_log = run("dispatcher-tests", [sys.executable, "-m", "unittest", "discover",
                                                 "-s", "tests", "-p", "test_*.py"])
        if not re.search(r"Ran 9 tests? in .+\n\nOK\s*$", dispatcher_log):
            raise RuntimeError("Dispatcher admission tests missing/failed/skipped")
        receipt["auxiliaryCounts"] = {
            "capability": dict(executed=2, passed=2, failed=0, skipped=0),
            "dispatcher": dict(executed=9, passed=9, failed=0, skipped=0),
        }
        scratch = CORE / "target" / "native-macos" / output.name
        ffi_libraries = {}
        for cpu in pin["cpuSlices"]:
            triple = {"arm64": "aarch64-apple-darwin", "x86_64": "x86_64-apple-darwin"}[cpu]
            ffi_target = CORE / "target" / "native-macos-ffi"
            run(f"ffi-{cpu}", [str(Path.home() / ".cargo/bin/cargo"), "+1.97.1", "build",
                              "-p", "editac-ffi", "--lib", "--locked", "--offline",
                              "--target", triple, "--target-dir", str(ffi_target)], timeout=300)
            library = ffi_target / triple / "debug/libeditac_ffi.dylib"
            ffi_libraries[cpu] = {"path": str(library),
                                  "sha256": hashlib.sha256(library.read_bytes()).hexdigest()}
            env["EDITAC_MACOS_FFI_LIBRARY_DIR"] = str(library.parent)
            run(f"build-{cpu}", ["xcrun", "swift", "build", "--package-path", str(ROOT),
                                "--scratch-path", str(scratch / cpu), "--arch", cpu,
                                "--sdk", actual["sdkPath"], "--build-tests"], timeout=300)
        receipt["ffiLibraries"] = ffi_libraries
        receipt["generatedBindings"] = {str(p.relative_to(CORE)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (CORE / "crates/editac-ffi/generated").glob("EditacNative*") if p.is_file()}
        if suite == "projection":
            fixture_root = output / "rich-fixture"
            fixture_root.mkdir()
            env["EDITAC_NATIVE_SESSION_EVIDENCE"] = str(fixture_root)
            fixture_log = run("rich-fixture", [str(Path.home() / ".cargo/bin/cargo"), "+1.97.1", "run",
                "-p", "editac-ffi", "--example", "session_rich_fixture", "--locked", "--offline",
                "--target", {"arm64": "aarch64-apple-darwin", "x86_64": "x86_64-apple-darwin"}[actual["cpu"]],
                "--target-dir", str(CORE / "target/native-macos-ffi")], timeout=300)
            manifest = Path(fixture_log.strip().splitlines()[-1])
            env["EDITAC_MACOS_RICH_FIXTURE"] = str(manifest)
            fixture = json.loads(manifest.read_text())
            receipt["richFixture"] = {"manifest": str(manifest),
                "manifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                "storeSha256": hashlib.sha256(Path(fixture["path"]).read_bytes()).hexdigest(),
                "factory": fixture["factory"], "providerCalls": fixture["providerCalls"]}
            for relative in ["crates/editac-ffi/examples/session_rich_fixture.rs", "crates/editac-ffi/tests/support/rich_fixture.rs"]:
                receipt["sharedSourceHashes"][relative] = hashlib.sha256((CORE / relative).read_bytes()).hexdigest()
        if suite == "styles":
            fixture_root = output / "style-fixture"
            env["EDITAC_NATIVE_SESSION_EVIDENCE"] = str(fixture_root)
            factory = ROOT / "tests/StylesFixture/Cargo.toml"
            fixture_log = run("style-fixture", [str(Path.home() / ".cargo/bin/cargo"), "+1.97.1", "run",
                "--manifest-path", str(factory), "--locked", "--offline",
                "--target", {"arm64": "aarch64-apple-darwin", "x86_64": "x86_64-apple-darwin"}[actual["cpu"]],
                "--target-dir", str(CORE / "target/native-macos-ffi")], timeout=300)
            manifest = Path(fixture_log.strip().splitlines()[-1])
            env["EDITAC_MACOS_STYLE_FIXTURE"] = str(manifest)
            env["EDITAC_MACOS_STYLE_EVIDENCE"] = str(output)
            fixture = json.loads(manifest.read_text())
            receipt["styleFixture"] = {"manifest": str(manifest),
                "manifestSha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                "storeSha256": hashlib.sha256(Path(fixture["path"]).read_bytes()).hexdigest(),
                "factory": fixture["factory"], "providerCalls": fixture["providerCalls"]}
        cpu = actual["cpu"]
        env["EDITAC_MACOS_FFI_LIBRARY_DIR"] = str(Path(ffi_libraries[cpu]["path"]).parent)
        arguments = ["--package-path", str(ROOT), "--scratch-path", str(scratch / cpu),
                     "--arch", cpu, "--sdk", actual["sdkPath"]]
        bin_path = Path(run("bin-path", ["xcrun", "swift", "build", *arguments, "--show-bin-path"]).strip())
        host = bin_path / "EditacMacOSTestHost"
        for slice_cpu in pin["cpuSlices"]:
            slice_host = scratch / slice_cpu / f"{slice_cpu}-apple-macosx" / "debug" / host.name
            if run(f"slice-{slice_cpu}", ["lipo", "-archs", str(slice_host)]).strip() != slice_cpu:
                raise RuntimeError(f"Incorrect binary CPU slice: {slice_cpu}")
        smoke = run("host-smoke", [str(host), "--smoke"], timeout=30)
        if "EDITAC_NATIVE_HOST_SMOKE_PASS" not in smoke:
            raise RuntimeError("Native executable host did not mount its AppKit control")
        log = run("xctest", ["xcrun", "swift", "test", *arguments, "--skip-build", "--filter", SUITES[suite][0]])
        receipt["counts"] = xctest_counts(log, SUITES[suite][1])
        receipt["artifacts"] = {str(p.relative_to(scratch)): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in scratch.rglob("EditacMacOSTestHost") if p.is_file()}
        receipt["scratchPath"] = str(scratch)
        receipt["state"] = "passed"
    except (RuntimeError, ValueError, OSError, KeyboardInterrupt) as error:
        receipt["failure"] = str(error)
    finally:
        receipt["finishedUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        test_log = output / "xctest.log"
        if receipt["counts"] is None and test_log.exists():
            try:
                receipt["counts"] = parse_xctest_counts(test_log.read_text())
            except ValueError:
                pass
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"state": receipt["state"], "counts": receipt["counts"],
                      "failure": receipt["failure"], "receipt": str(output / "receipt.json")}))
    return 0 if receipt["state"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
