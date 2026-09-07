import AppKit
import ImageIO

// The "more" surface behind the palette's screenshot strip (PHNX-4006): the six
// newest thumbnails collapse into a scrollable grid grouped by hour (last 24 h)
// then by day. Each cell shows the thumbnail, the capture time, and the first
// recognized line as a caption. A single click attaches (same as a strip click); a
// double click previews the full image in Preview.app. It reads the OCR index
// (ScreenshotIndex) and never runs Vision or touches the DB itself.

struct ScreenshotGroup {
    let id: String
    let title: String
    let rows: [ScreenshotRow]
}

enum ScreenshotGrouping {
    static let dayWindow: TimeInterval = 24 * 60 * 60

    /// Group newest-first rows: captures inside the last 24 h bucket by hour, older
    /// ones by calendar day. Group order follows the rows (newest first), and each
    /// group keeps its rows' order. Pure — exercised by MENUBAR_OCR_TEST.
    static func groupRows(_ rows: [ScreenshotRow], now: Date,
                          calendar: Calendar = .current) -> [ScreenshotGroup] {
        let hourFmt = DateFormatter()
        hourFmt.calendar = calendar
        hourFmt.locale = .current
        hourFmt.dateFormat = "h a"
        let dayFmt = DateFormatter()
        dayFmt.calendar = calendar
        dayFmt.locale = .current
        dayFmt.dateFormat = "EEEE, MMM d"

        var order: [String] = []
        var byKey: [String: (title: String, rows: [ScreenshotRow])] = [:]
        for row in rows {
            let recent = now.timeIntervalSince(row.takenAt) < dayWindow && row.takenAt <= now
            let key: String
            let title: String
            if recent {
                let c = calendar.dateComponents([.year, .month, .day, .hour], from: row.takenAt)
                key = "h-\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)-\(c.hour ?? 0)"
                title = hourFmt.string(from: row.takenAt)
            } else {
                let c = calendar.dateComponents([.year, .month, .day], from: row.takenAt)
                key = "d-\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
                title = dayFmt.string(from: row.takenAt)
            }
            if byKey[key] == nil { byKey[key] = (title, []); order.append(key) }
            byKey[key]?.rows.append(row)
        }
        return order.map { ScreenshotGroup(id: $0, title: byKey[$0]!.title, rows: byKey[$0]!.rows) }
    }
}

final class ScreenshotGridView: NSView {
    var onAttach: ((String) -> Void)?
    var onPreview: ((String) -> Void)?

    private let scroll = NSScrollView()
    private let collection = NSCollectionView()
    private var groups: [ScreenshotGroup] = []
    private var thumbnailCache: [String: NSImage] = [:]
    private static let decodeQueue = DispatchQueue(label: "agents.screenshot-grid.decode", qos: .userInitiated)

    static let cellID = NSUserInterfaceItemIdentifier("ScreenshotCell")
    static let headerID = NSUserInterfaceItemIdentifier("ScreenshotHeader")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false

        let layout = NSCollectionViewFlowLayout()
        layout.itemSize = NSSize(width: 132, height: 116)
        layout.minimumInteritemSpacing = 8
        layout.minimumLineSpacing = 10
        layout.sectionInset = NSEdgeInsets(top: 4, left: 0, bottom: 10, right: 0)
        // A vertical flow layout spans headers to the full width; the width here
        // must be non-zero or the header is never created (its labels vanish).
        layout.headerReferenceSize = NSSize(width: 320, height: 22)

        collection.collectionViewLayout = layout
        collection.isSelectable = false
        collection.backgroundColors = [.clear]
        collection.dataSource = self
        collection.register(ScreenshotCell.self, forItemWithIdentifier: Self.cellID)
        collection.register(ScreenshotHeader.self,
                            forSupplementaryViewOfKind: NSCollectionView.elementKindSectionHeader,
                            withIdentifier: Self.headerID)

        scroll.documentView = collection
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.scrollerStyle = .overlay
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    func setGroups(_ groups: [ScreenshotGroup]) {
        self.groups = groups
        collection.reloadData()
        prefetchThumbnails(for: groups)
    }

    private func prefetchThumbnails(for groups: [ScreenshotGroup]) {
        let paths = groups.flatMap { $0.rows.map(\.path) }.filter { thumbnailCache[$0] == nil }
        guard !paths.isEmpty else { return }
        Self.decodeQueue.async { [weak self] in
            var decoded: [String: NSImage] = [:]
            for p in paths { if let img = Self.thumbnail(at: p) { decoded[p] = img } }
            DispatchQueue.main.async {
                guard let self else { return }
                for (k, v) in decoded { self.thumbnailCache[k] = v }
                self.collection.reloadData()
            }
        }
    }

    static func thumbnail(at path: String) -> NSImage? {
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 256,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}

extension ScreenshotGridView: NSCollectionViewDataSource {
    func numberOfSections(in collectionView: NSCollectionView) -> Int { groups.count }

    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
        groups[section].rows.count
    }

    func collectionView(_ collectionView: NSCollectionView,
                        itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
        let item = collectionView.makeItem(withIdentifier: Self.cellID, for: indexPath)
        guard let cell = item as? ScreenshotCell else { return item }
        let row = groups[indexPath.section].rows[indexPath.item]
        cell.configure(row: row, thumbnail: thumbnailCache[row.path])
        cell.onAttach = { [weak self] path in self?.onAttach?(path) }
        cell.onPreview = { [weak self] path in self?.onPreview?(path) }
        return cell
    }

    func collectionView(_ collectionView: NSCollectionView,
                        viewForSupplementaryElementOfKind kind: NSCollectionView.SupplementaryElementKind,
                        at indexPath: IndexPath) -> NSView {
        let view = collectionView.makeSupplementaryView(ofKind: kind, withIdentifier: Self.headerID, for: indexPath)
        (view as? ScreenshotHeader)?.title = groups[indexPath.section].title
        return view
    }
}

// One capture in the grid. Custom mouse handling (not NSCollectionView selection)
// so a single click attaches and a double click previews — the same gesture split
// ClipThumbView uses in the strip.
final class ScreenshotCell: NSCollectionViewItem {
    var onAttach: ((String) -> Void)?
    var onPreview: ((String) -> Void)?
    private var path = ""

    private let thumb = NSImageView()
    private let time = NSTextField(labelWithString: "")
    private let caption = NSTextField(labelWithString: "")

    override func loadView() { view = ClickThroughView() }

    override func viewDidLoad() {
        super.viewDidLoad()
        (view as? ClickThroughView)?.onMouseDown = { [weak self] event in self?.handleClick(event) }

        thumb.imageScaling = .scaleProportionallyUpOrDown
        thumb.wantsLayer = true
        thumb.layer?.cornerRadius = 6
        thumb.layer?.masksToBounds = true
        thumb.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.15).cgColor
        thumb.translatesAutoresizingMaskIntoConstraints = false

        time.font = .monospacedSystemFont(ofSize: 10, weight: .medium)
        time.textColor = .secondaryLabelColor
        caption.font = .systemFont(ofSize: 10)
        caption.textColor = .tertiaryLabelColor
        caption.lineBreakMode = .byTruncatingTail
        caption.maximumNumberOfLines = 1
        caption.cell?.truncatesLastVisibleLine = true

        let stack = NSStackView(views: [thumb, time, caption])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: view.topAnchor),
            thumb.widthAnchor.constraint(equalToConstant: 132),
            thumb.heightAnchor.constraint(equalToConstant: 82),
            caption.widthAnchor.constraint(equalToConstant: 132),
        ])
    }

    func configure(row: ScreenshotRow, thumbnail: NSImage?) {
        path = row.path
        thumb.image = thumbnail
        let fmt = DateFormatter()
        fmt.dateFormat = "h:mm a"
        time.stringValue = fmt.string(from: row.takenAt)
        caption.stringValue = row.firstLine
        caption.toolTip = row.firstLine.isEmpty ? nil : row.firstLine
        view.toolTip = (row.path as NSString).lastPathComponent
    }

    private func handleClick(_ event: NSEvent) {
        if event.clickCount >= 2 {
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(fireAttach), object: nil)
            onPreview?(path)
        } else {
            perform(#selector(fireAttach), with: nil, afterDelay: NSEvent.doubleClickInterval)
        }
    }
    @objc private func fireAttach() { onAttach?(path) }
}

// Section header showing the group title (an hour or a day).
final class ScreenshotHeader: NSView, NSCollectionViewElement {
    var title: String = "" { didSet { label.stringValue = title } }
    private let label = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        label.font = .monospacedSystemFont(ofSize: 10, weight: .semibold)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }
}

// A plain view that forwards mouseDown to a closure — the cell's click handling.
final class ClickThroughView: NSView {
    var onMouseDown: ((NSEvent) -> Void)?
    override func mouseDown(with event: NSEvent) { onMouseDown?(event) }
}
