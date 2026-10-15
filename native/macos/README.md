# macOS native SDK bootstrap

DSK-1.1 builds an AppKit SDK target, a windowed native test host and one real
XCTest case. The text view is an empty, noneditable projection until shared
session binding. This bootstrap establishes no editing, toolkit feasibility,
IME, accessibility or release support. All capability claims start unqualified.

From `core`:

```sh
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
bash native/macos/scripts/check.sh bootstrap
```

The dispatcher requires the exact Xcode, Swift, SDK and test-host versions in
`toolchain.json`, Node 24.19.0, a macOS GUI login session, and Python 3. It builds both arm64
and x86_64 slices with a macOS 14.0 deployment minimum. The declared deployment
range is 14.0–26.5; only the pinned arm64 host executes tests. The x86_64 slice
is compile evidence, not runtime qualification. Other OS/CPU environments need
their own future qualification. No signing, publication or external service is
involved. AppKit's native text system is the candidate; DSK-1.2 owns TextKit and
cell/atom feasibility rather than this bootstrap.

Each invocation writes full commands, tool versions, logs, counts, source and
binary hashes to a unique `core/.artifacts/macos/bootstrap-*/receipt.json`.
Build outputs are isolated under `core/target/native-macos/`. Tool/build/test
failures, unknown suites, missing tests, zero matches and skips fail the check.
Future named suites must be implemented before the dispatcher admits them.
The test host exits automatically with `--smoke`; without that flag it displays
a native window until closed. Neither route loads credentials or calls providers.

`python3 -m unittest discover -s native/macos/tests -p 'test_*.py'` exercises
dispatcher count admission separately from the actual native XCTest.

Native control availability and architecture:
[Apple NSTextView](https://developer.apple.com/documentation/appkit/nstextview),
[Apple text system organization](https://developer.apple.com/library/archive/documentation/TextFonts/Conceptual/CocoaTextArchitecture/TextSystemArchitecture/ArchitectureOverview.html).
These established AppKit APIs predate the declared minimum; newer APIs need
explicit availability guards and their own qualified runtime cases.
