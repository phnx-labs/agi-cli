// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MenubarHelper",
    platforms: [.macOS(.v14)],
    products: [
        // The PRODUCT name is the emitted executable's basename (RUSH-3101) —
        // "AGI Menu", not the target name below. Kept distinct from the target
        // so the module/source-dir name (and every `import` of it) stays a
        // valid Swift identifier while the shipped binary carries the branded
        // name TCC shows when launchd execs it directly.
        .executable(name: "AGI Menu", targets: ["MenubarHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "MenubarHelper",
            path: "Sources/MenubarHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("Vision"),
                .linkedFramework("Carbon"),
                .linkedLibrary("sqlite3"),
            ]
        )
    ]
)
