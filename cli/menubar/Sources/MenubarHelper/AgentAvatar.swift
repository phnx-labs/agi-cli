import AppKit

// Per-agent avatar for the RIGHT-hand slot of a desktop notification.
//
// macOS renders two images on a notification: the sending bundle's app icon on
// the LEFT (resolved by LaunchServices from MenubarHelper.app — see
// refreshBundleIconRegistration in install-menubar.ts) and `contentImage` on the
// RIGHT. This type owns the right-hand one: who the notification is *about*.
// A run that Claude finished shows Claude's mark; a Codex routine shows Codex's.
// Before this, `contentImage` was the agents-cli app icon, so both slots carried
// the same lime `a` and the right slot said nothing the left did not.
//
// The mark is drawn, not shipped as an asset: a bundled per-agent image set would
// add fifteen binaries to a helper that is code-signed on every release, and the
// upstream logos are trademarks we do not redistribute. A brand-colored rounded
// tile carrying the agent's two-letter mark reads at banner size (the image
// renders at ~44pt) and stays legible in both light and dark Notification Center.
enum AgentAvatar {
    /// Rendered edge length. Notification Center scales `contentImage` down to
    /// roughly 44pt; rendering at 128 keeps the mark crisp on Retina.
    private static let side: CGFloat = 128

    /// A harness's visual identity on the tile.
    struct Brand {
        /// Two-letter mark. Deliberately NOT the first letter: claude/codex/
        /// cursor/copilot all start with `c` and grok/goose with `g`, so a
        /// single initial makes four harnesses the same badge. Each mark is
        /// picked here so no two collide — the completeness self-test pins that.
        let mark: String
        let color: NSColor
    }

    /// Brand per agent id. Keys are `AgentId` (cli/src/lib/types.ts) — the
    /// ids the CLI passes via `--notify --agent`. An id absent here is not an
    /// error: it falls back to its own initial on the agents-cli lime, so a
    /// harness newly added to the registry still gets a usable avatar before
    /// anyone picks its brand.
    static let brands: [String: Brand] = [
        "claude":      Brand(mark: "CL", color: rgb(0xD9, 0x77, 0x57)),
        "codex":       Brand(mark: "CX", color: rgb(0x10, 0xA3, 0x7F)),
        "gemini":      Brand(mark: "GE", color: rgb(0x42, 0x85, 0xF4)),
        "cursor":      Brand(mark: "CU", color: rgb(0x37, 0x41, 0x51)),
        "opencode":    Brand(mark: "OC", color: rgb(0xFB, 0x92, 0x3C)),
        "openclaw":    Brand(mark: "OW", color: rgb(0xE0, 0x5D, 0x38)),
        "copilot":     Brand(mark: "CP", color: rgb(0x24, 0x29, 0x2F)),
        "amp":         Brand(mark: "AM", color: rgb(0xE1, 0x1D, 0x48)),
        "goose":       Brand(mark: "GO", color: rgb(0x0D, 0x9C, 0x9C)),
        "antigravity": Brand(mark: "AG", color: rgb(0x1A, 0x73, 0xE8)),
        "grok":        Brand(mark: "GK", color: rgb(0x11, 0x18, 0x27)),
        "kimi":        Brand(mark: "KM", color: rgb(0x6D, 0x28, 0xD9)),
        "droid":       Brand(mark: "DR", color: rgb(0x10, 0xB9, 0x81)),
        "hermes":      Brand(mark: "HM", color: rgb(0xF5, 0x9E, 0x0B)),
    ]

    /// agents-cli lime — the tile for an id with no brand entry.
    private static let fallbackColor = rgb(0xA3, 0xE6, 0x35)

    private static func rgb(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(r) / 255.0, green: CGFloat(g) / 255.0, blue: CGFloat(b) / 255.0, alpha: 1)
    }

    /// Brand for an agent id, or nil when there is no agent to depict. Case- and
    /// whitespace-insensitive, so `--agent " Claude "` still lands on the brand.
    /// Exposed for the self-test.
    static func brand(for agent: String?) -> Brand? {
        guard let key = normalize(agent), let first = key.first else { return nil }
        return brands[key] ?? Brand(mark: String(first).uppercased(), color: fallbackColor)
    }

    /// Black or white mark, whichever contrasts better with the tile. Picks by
    /// WCAG relative luminance so a dark brand (grok, copilot) gets white and a
    /// light one (opencode, hermes) gets black — the contrast decision is a pure
    /// function of the color, not a second hand-maintained table that could drift
    /// out of step with `brands`. Exposed for the self-test.
    static func glyphColor(on tile: NSColor) -> NSColor {
        // WCAG contrast against black is (L + 0.05) / 0.05 and against white is
        // 1.05 / (L + 0.05); they cross at L = sqrt(1.05 * 0.05) - 0.05 ≈ 0.179.
        // Picking a brighter-looking "midpoint" instead (0.45, or 0.5) hands white
        // to mid-brights like amber, where black reads far better.
        let pivot: CGFloat = 0.1791
        let c = tile.usingColorSpace(.sRGB) ?? tile
        func lin(_ v: CGFloat) -> CGFloat {
            v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        let luminance = 0.2126 * lin(c.redComponent) + 0.7152 * lin(c.greenComponent) + 0.0722 * lin(c.blueComponent)
        return luminance > pivot ? .black : .white
    }

    /// The notification's right-hand image for `agent`, or nil when there is no
    /// agent context to depict — the right slot then stays empty rather than
    /// showing a meaningless badge.
    static func image(for agent: String?) -> NSImage? {
        guard let brand = brand(for: agent) else { return nil }
        let ink = glyphColor(on: brand.color)
        let size = NSSize(width: side, height: side)
        return NSImage(size: size, flipped: false) { rect in
            let radius = rect.width * 0.22
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).addClip()
            brand.color.setFill()
            rect.fill()

            let text = brand.mark as NSString
            // Size the mark to the tile rather than to a fixed point size: a
            // one-letter fallback and a two-letter brand must both sit inside the
            // same 76%-wide box, so a new mark can never overflow the tile.
            let box = rect.width * 0.76
            var pt = rect.width * 0.5
            var attrs: [NSAttributedString.Key: Any] = [:]
            var bounds = NSSize.zero
            for _ in 0..<24 {
                attrs = [.font: NSFont.monospacedSystemFont(ofSize: pt, weight: .bold), .foregroundColor: ink]
                bounds = text.size(withAttributes: attrs)
                if bounds.width <= box { break }
                pt *= 0.92
            }
            text.draw(at: NSPoint(x: rect.midX - bounds.width / 2, y: rect.midY - bounds.height / 2),
                      withAttributes: attrs)
            return true
        }
    }

    /// Write the agent's avatar to a temp PNG and return its file URL, for use as
    /// a `UNNotificationAttachment` on a UserNotifications banner (the right-hand
    /// image slot the deprecated `NSUserNotification.contentImage` used to fill).
    /// nil when there is no agent to depict or the PNG could not be encoded. The
    /// caller owns the file; the notification center copies it into its own store,
    /// so it can be left in the temp dir.
    static func attachmentURL(for agent: String?) -> URL? {
        guard let image = image(for: agent),
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        // A stable-per-agent name keeps the temp dir from growing one file per
        // banner: UNNotificationAttachment copies the bytes at add time, so
        // overwriting the same path between banners is safe.
        let key = normalize(agent) ?? "agent"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agents-notify-avatar-\(key).png")
        do {
            try png.write(to: url)
            return url
        } catch {
            return nil
        }
    }

    /// Lowercased, trimmed agent id, or nil when blank.
    private static func normalize(_ agent: String?) -> String? {
        guard let raw = agent?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !raw.isEmpty else { return nil }
        return raw
    }
}
