// swift-tools-version: 6.3
import PackageDescription
import Foundation

let libraryDirectory = ProcessInfo.processInfo.environment["EDITAC_MACOS_FFI_LIBRARY_DIR"]
    ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../target/debug").standardized.path

let package = Package(
    name: "EditacMacOS",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "EditacMacOS", targets: ["EditacMacOS"]),
        .executable(name: "EditacMacOSTestHost", targets: ["EditacMacOSTestHost"]),
    ],
    targets: [
        .systemLibrary(name: "EditacNativeFFI", path: "Bindings/FFI"),
        .target(name: "EditacNative", dependencies: ["EditacNativeFFI"], path: "Bindings/Swift",
                swiftSettings: [.swiftLanguageMode(.v5)],
                linkerSettings: [.unsafeFlags(["-L", libraryDirectory, "-leditac_ffi",
                                               "-Xlinker", "-rpath", "-Xlinker", libraryDirectory])]),
        .target(name: "EditacMacOS", dependencies: ["EditacNative"]),
        .executableTarget(name: "EditacMacOSTestHost", dependencies: ["EditacMacOS"]),
        // Internal feasibility harness; not an SDK product or semantic adapter.
        .target(name: "EditacMacOSProbe", dependencies: ["EditacMacOS"],
                path: "probe/Sources"),
        .testTarget(name: "EditacMacOSToolkitTests", dependencies: ["EditacMacOS", "EditacMacOSProbe"],
                    path: "tests/Toolkit"),
        .testTarget(name: "EditacMacOSCommandsTests", dependencies: ["EditacMacOS"],
                    path: "tests/Commands"),
        .testTarget(name: "EditacMacOSTableEditingTests", dependencies: ["EditacMacOS"],
                    path: "tests/TableEditing"),
        .testTarget(name: "EditacMacOSTableProjectionTests", dependencies: ["EditacMacOS"],
                    path: "tests/TableProjection"),
        .testTarget(name: "EditacMacOSStylesTests", dependencies: ["EditacMacOS"],
                    path: "tests/Styles"),
        .testTarget(name: "EditacMacOSCompositionTests", dependencies: ["EditacMacOS"],
                    path: "tests/Composition"),
        .testTarget(name: "EditacMacOSEditsTests", dependencies: ["EditacMacOS"],
                    path: "tests/Edits"),
        .testTarget(name: "EditacMacOSProjectionTests", dependencies: ["EditacMacOS"],
                    path: "tests/Projection"),
        .testTarget(name: "EditacMacOSSessionTests", dependencies: ["EditacMacOS"],
                    path: "tests/Session"),
        .testTarget(name: "EditacMacOSBootstrapTests", dependencies: ["EditacMacOS"],
                    path: "tests/Bootstrap"),
    ],
    swiftLanguageModes: [.v6]
)
