#!/usr/bin/env python3
"""Deterministic generated-Swift proof for DSK-1.12-P2; no provider/network IO."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

CORE = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    env["PATH"] = str(Path.home() / ".cargo/bin") + os.pathsep + env.get("PATH", "")
    env["EDITAC_NATIVE_SESSION_EVIDENCE"] = str(out / "stores")
    generated = CORE / "crates/editac-ffi/generated"
    library = CORE / "target/debug/libeditac_ffi.dylib"
    receipt = {"gate": "DSK-1.12-P2", "state": "failed", "commands": [],
               "providerCalls": 0, "qualification": "Actual generated Swift + shared Rust/SQLite on macOS; native renderer P3 remains unqualified"}

    def run(name, command):
        log = out / (name + ".log")
        with log.open("w") as stream:
            result = subprocess.run(list(map(str, command)), cwd=CORE, env=env,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=900)
        receipt["commands"].append({"id": name, "command": list(map(str, command)),
                                    "exit": result.returncode, "log": str(log), "sha256": digest(log)})
        if result.returncode:
            raise RuntimeError(f"{name} failed; inspect {log}")
        return log

    try:
        run("bindings", ["python3", CORE / "tests/native/bounded-bindings.py", "--output", out / "bindings"])
        run("fixture", [Path.home() / ".cargo/bin/cargo", "+1.97.1", "test", "-p", "editac-ffi", "--locked",
                        "--test", "native_session_extensions", "generated_swift_fixture_preserves_actual_math_store", "--", "--exact"])
        source = CORE / "tests/native/session-extension-proof/main.swift"
        binary = out / "session-extension-proof"
        run("swift-build", ["xcrun", "swiftc", "-swift-version", "5", "-Onone", "-I", generated,
                            "-Xcc", "-fmodule-map-file=" + str(generated / "EditacNativeFFI.modulemap"),
                            "-L", library.parent, "-leditac_ffi", "-Xlinker", "-rpath", "-Xlinker", library.parent,
                            generated / "EditacNative.swift", source, "-o", binary])
        runtime = run("swift-runtime", [binary, out / "stores/swift-fixture.json"])
        cases = json.loads(runtime.read_text())
        assert cases["executed"] > 0 and cases["passed"] == cases["executed"] and cases["failed"] == cases["skipped"] == 0
        receipt.update(state="passed", counts={k: cases[k] for k in ("executed", "passed", "failed", "skipped")}, cases=cases["cases"])
        receipt["library"] = {"path": str(library), "sha256": digest(library)}
        receipt["sourceHashes"] = {str(p.relative_to(CORE)): digest(p) for p in [
            source, CORE / "tests/native/session-extensions.py", CORE / "crates/editac-ffi/src/session.rs",
            CORE / "crates/editac-core/src/commands/editor.rs", CORE / "crates/editac-core/src/commands/format.rs",
            CORE / "crates/editac-core/src/interchange.rs", CORE / "crates/editac-core/src/modules/registry.rs",
            CORE / "crates/editac-session/src/edit_service.rs"]}
        receipt["generatedHashes"] = {str(p.relative_to(CORE)): digest(p) for p in generated.rglob("*") if p.is_file()}
    finally:
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"state": receipt["state"], "counts": receipt["counts"], "receipt": str(out / "receipt.json")}))


if __name__ == "__main__":
    main()
