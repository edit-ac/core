#!/usr/bin/env python3
"""NAT-1.1 native qualification; deterministic fixtures, never provider calls.

Run from any directory with an unused absolute --output evidence directory.
The selected Rust target directory is owned by this invocation and may be
removed after qualification; logs, receipts and fixture bytes are retained.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone


CORE = Path(__file__).resolve().parents[2]
TOOLCHAIN = "1.97.1"
NODE = Path.home() / ".nvm/versions/node/v24.19.0/bin"
CARGO = Path.home() / ".cargo/bin/cargo"
FORBIDDEN = {"web-sys", "js-sys", "wasm-bindgen", "react", "jni", "ndk", "objc2"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(name, command, output, env):
    log = output / f"{name}.log"
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=CORE, env=env, stdout=stream,
                                stderr=subprocess.STDOUT, check=False)
    return {"id": name, "command": shlex.join(map(str, command)),
            "exit": result.returncode, "log": str(log), "sha256": digest(log)}


def inventory(env):
    sdk = Path(env.get("ANDROID_HOME", str(Path.home() / "Library/Android/sdk")))
    probes = {
        "rustc": [str(CARGO.parent / "rustc"), f"+{TOOLCHAIN}", "-vV"],
        "cargo": [str(CARGO), f"+{TOOLCHAIN}", "--version"],
        "node": [str(NODE / "node"), "--version"],
        "npm": [str(NODE / "npm"), "--version"],
        "swift": ["swift", "--version"],
        "xcode": ["xcodebuild", "-version"],
        "iphoneos": ["xcrun", "--sdk", "iphoneos", "--show-sdk-version"],
        "iphonesimulator": ["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"],
        "kotlin": ["kotlinc", "-version"],
        "java": ["java", "-version"],
        "gradle": ["gradle", "--version"],
        "adb": [str(sdk / "platform-tools/adb"), "version"],
    }
    versions = {}
    for name, command in probes.items():
        try:
            p = subprocess.run(command, env=env, capture_output=True, text=True,
                               timeout=30, check=False)
            versions[name] = {"command": shlex.join(command), "exit": p.returncode,
                              "output": (p.stdout + p.stderr).strip()}
        except (OSError, subprocess.TimeoutExpired) as error:
            versions[name] = {"command": shlex.join(command), "exit": None,
                              "output": str(error)}
    versions["android_sdk"] = {"path": str(sdk), "present": sdk.is_dir(),
                               "ndk": sorted(str(p) for p in (sdk / "ndk").glob("*/source.properties")),
                               "platforms": sorted(p.name for p in (sdk / "platforms").glob("*"))}
    for name in ("kotlin", "gradle", "java"):
        if versions[name]["exit"] != 0:
            versions[name]["unblock"] = {
                "kotlin": "Install the Kotlin compiler version pinned by NAT-1.4 and expose kotlinc on the fixture PATH.",
                "gradle": "Provide the pinned NAT-1.4/NAT-1.6 Gradle wrapper (or install its matching Gradle distribution).",
                "java": "Install the JDK required by the pinned Kotlin/Android Gradle build and select JAVA_HOME.",
            }[name]
    for name in ("swift", "xcode", "iphoneos", "iphonesimulator"):
        if versions[name]["exit"] != 0:
            versions[name]["unblock"] = "Install full Xcode with iOS SDK/Simulator support; select it with xcode-select and complete first-launch setup."
    if not versions["android_sdk"]["ndk"]:
        versions["android_sdk"]["unblock"] = "Install the NAT-1.4/NAT-1.6 pinned side-by-side Android NDK with sdkmanager; expose its toolchain to the Android build."
    return versions


def suites(log):
    name = None
    results = []
    for line in log.read_text().splitlines():
        match = re.search(r"Running (?:unittests |tests/)([^ ]+)", line)
        if match:
            name = "lib" if match[1].startswith("src/") else Path(match[1]).stem
        match = re.search(r"test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored;.*?(\d+) filtered out", line)
        if match:
            passed, failed, skipped, filtered = map(int, match.groups()[1:])
            results.append({"target": name, "result": match[1], "executed": passed + failed,
                            "passed": passed, "failed": failed, "skipped": skipped, "filtered": filtered})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env["PATH"] = os.pathsep.join([str(NODE), str(CARGO.parent), env.get("PATH", "")])
    env["CARGO_TARGET_DIR"] = str(output / "build")
    # Every fixture output is separate from the shared architecture evidence.
    for path in (CORE / "crates/editac-core").rglob("*.rs"):
        for variable in re.findall(r"EDITAC_[A-Z_]+", path.read_text()):
            directory = output / "fixtures" / variable
            directory.mkdir(parents=True, exist_ok=True)
            env[variable] = str(directory)
    receipt = {"gate": "NAT-1.1", "started_utc": datetime.now(timezone.utc).isoformat(),
               "host": {"system": platform.platform(), "architecture": platform.machine()},
               "core_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=CORE, text=True).strip(),
               "build_directory": env["CARGO_TARGET_DIR"], "checks": [], "toolchains": inventory(env)}
    errors = []
    try:
        if receipt["toolchains"]["node"]["output"] != "v24.19.0":
            raise RuntimeError("Pinned Node v24.19.0 is unavailable")
        host = re.search(r"^host: (.+)$", receipt["toolchains"]["rustc"]["output"], re.M)
        if not host:
            raise RuntimeError("Pinned native Rust toolchain is unavailable")
        metadata_check = run("cargo-metadata", [str(CARGO), f"+{TOOLCHAIN}", "metadata", "--locked",
                                                "--format-version", "1", "--filter-platform", host[1]], output, env)
        receipt["checks"].append(metadata_check)
        if metadata_check["exit"]:
            raise RuntimeError("Cargo metadata failed; see preserved log")
        metadata = json.loads(next(line for line in (output / "cargo-metadata.log").read_text().splitlines()
                                   if line.startswith('{"packages":')))
        package = next(p for p in metadata["packages"] if p["name"] == "editac-core")
        receipt["targets"] = [{k: t[k] for k in ("name", "kind", "src_path", "test")} for t in package["targets"]]
        tests = sorted(t["name"] for t in package["targets"] if "test" in t["kind"])
        if "migration" not in tests:
            raise RuntimeError("Expected deferred migration target missing; review inventory before changing exclusion")
        selected = [name for name in tests if name != "migration"]
        receipt["selected"] = ["lib", *selected]
        receipt["excluded"] = [{"target": "migration", "reason": "User-content migration deferred until full app completion/qualification; never executed here"}]
        if not {"anchors", "text_commands", "patches"}.issubset(selected):
            raise RuntimeError("Required command/anchor/patch suites missing")
        nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
        packages = {p["id"]: p for p in metadata["packages"]}
        pending, reached = [package["id"]], set()
        while pending:
            identity = pending.pop()
            if identity in reached:
                continue
            reached.add(identity)
            pending.extend(d["pkg"] for d in nodes[identity]["deps"])
        dependencies = sorted(packages[p]["name"] for p in reached)
        imports = []
        for path in (CORE / "crates/editac-core/src").rglob("*.rs"):
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if re.search(r"\b(?:use|extern\s+crate)\s+(?:web_sys|js_sys|wasm_bindgen|jni|ndk|objc2)\b", line):
                    imports.append(f"{path.relative_to(CORE)}:{number}")
        receipt["portability_audit"] = {"native_dependency_closure": dependencies,
                                        "forbidden_dependencies": sorted(FORBIDDEN.intersection(dependencies)),
                                        "platform_imports": imports}
        if FORBIDDEN.intersection(dependencies) or imports:
            raise RuntimeError("Platform dependency found in portable core")
        compilation = run("native-check", [str(CARGO), f"+{TOOLCHAIN}", "check", "-p", "editac-core", "--target", host[1], "--locked"], output, env)
        receipt["checks"].append(compilation)
        if compilation["exit"]:
            raise RuntimeError("Native compilation failed; see preserved log")
        command = [str(CARGO), f"+{TOOLCHAIN}", "test", "-p", "editac-core", "--lib"]
        for name in selected:
            command.extend(["--test", name])
        command.extend(["--target", host[1], "--locked"])
        test = run("native-tests", command, output, env)
        test["suites"] = suites(output / "native-tests.log")
        test["counts"] = {key: sum(s[key] for s in test["suites"]) for key in ("executed", "passed", "failed", "skipped", "filtered")}
        receipt["checks"].append(test)
        actual = [s["target"] for s in test["suites"]]
        if sorted(actual) != sorted(receipt["selected"]):
            errors.append("Not every selected target produced exactly one result")
        if any(s["executed"] == 0 or s["skipped"] or s["filtered"] or s["failed"] for s in test["suites"]):
            errors.append("Missing/failed/skipped/filtered tests do not satisfy acceptance")
        if test["exit"]:
            errors.append("Native selected-target tests failed; preserve failure log and repair before retry")
    except (OSError, ValueError, RuntimeError, StopIteration) as error:
        errors.append(str(error))
    sources = [CORE / "Cargo.toml", CORE / "Cargo.lock", CORE / "rust-toolchain.toml", Path(__file__).resolve()]
    sources += [p for root in (CORE / "crates/editac-core", CORE / "fixtures") for p in root.rglob("*") if p.is_file()]
    receipt["source_hashes"] = {str(p.relative_to(CORE)): digest(p) for p in sorted(set(sources))}
    receipt["fixture_artifacts"] = {str(p.relative_to(output)): digest(p) for p in sorted((output / "fixtures").rglob("*")) if p.is_file()}
    receipt["errors"] = errors
    receipt["state"] = "FAILED" if errors else "PASSED"
    receipt["finished_utc"] = datetime.now(timezone.utc).isoformat()
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"state": receipt["state"], "receipt": str(output / "receipt.json"),
                      "errors": errors, "counts": next((c["counts"] for c in receipt["checks"] if "counts" in c), None)}))
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
