// swift-tools-version: 6.3
import PackageDescription

let package = Package(
    name: "EditacMacOS",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "EditacMacOS", targets: ["EditacMacOS"]),
        .executable(name: "EditacMacOSTestHost", targets: ["EditacMacOSTestHost"]),
    ],
    targets: [
        .target(name: "EditacMacOS"),
        .executableTarget(name: "EditacMacOSTestHost", dependencies: ["EditacMacOS"]),
        .testTarget(name: "EditacMacOSBootstrapTests", dependencies: ["EditacMacOS"],
                    path: "tests/Bootstrap"),
    ],
    swiftLanguageModes: [.v6]
)
