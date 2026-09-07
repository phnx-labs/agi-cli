import CoreServices
import Foundation

// Watches the directories screenshots actually land in
// (`AgentsCLI.screenshotSourceDirs()`) and fires when one of them changes, so the
// palette's thumbnail strip is LIVE.
//
// The bug this closes (PHNX-4001): the strip was filled by `hydrateContent()`,
// which ran only on summon and refused to re-run inside 30 seconds, and nothing
// watched the folders. So the loop was — open the palette, realize you need a
// screenshot, take one, and the shot you just took is not there; you had to
// dismiss and re-summon, and even that did nothing for the first half minute.
//
// FSEvents rather than a poll timer: a poll would be a repeating timer stat-ing
// three directories forever, and the helper's rule is that a repeating timer must
// earn its keep (ChildProcess.swift). FSEvents is edge-triggered — zero cost while
// nothing changes — and the stream only runs while the panel is VISIBLE, so a
// palette nobody has open watches nothing.
//
// This is not a second scheduler (spec SING-2): it detects a local file change and
// re-renders a view. It never starts, resumes, kills, or dispatches anything.
final class ScreenshotWatcher {
    /// FSEvents coalescing window. Long enough that `screencapture` writing a file
    /// produces one callback rather than three, short enough to stay well inside
    /// the "thumbnail appears within 2s" bar.
    static let latency: CFTimeInterval = 0.5

    private var stream: FSEventStreamRef?
    private var watchedPaths: [String] = []
    private let onChange: () -> Void

    /// `onChange` is always invoked on the main queue.
    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    deinit { stop() }

    var isRunning: Bool { stream != nil }

    /// Start (or restart) watching `paths`. Restarting on an unchanged path set is
    /// a no-op, so a repeated summon does not churn the stream.
    func start(paths: [String]) {
        guard !paths.isEmpty else { stop(); return }
        if stream != nil, watchedPaths == paths { return }
        stop()
        watchedPaths = paths

        // The callback gets an unretained pointer to self; `stop()` runs before
        // deinit completes, so the stream can never outlive this object.
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil)

        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<ScreenshotWatcher>.fromOpaque(info).takeUnretainedValue()
            watcher.fire()
        }

        guard let created = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            Self.latency,
            // FileEvents: report the file that changed rather than only its
            // directory, so a new screenshot is one event. NoDefer: deliver the
            // FIRST event of a burst after the latency window, which is what keeps
            // a single screenshot inside the 2s bar.
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagNoDefer)
        ) else {
            watchedPaths = []
            return
        }
        stream = created
        // Dispatch-queue scheduling (not a run loop): the stream must keep
        // delivering while AppKit's run loop is in a modal/tracking mode — the
        // user holding the palette open with a popup down is exactly when a new
        // screenshot arrives.
        FSEventStreamSetDispatchQueue(created, DispatchQueue.main)
        FSEventStreamStart(created)
    }

    func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
        watchedPaths = []
    }

    private func fire() {
        // Already on the main queue (FSEventStreamSetDispatchQueue above); the
        // hop keeps the contract explicit for any future scheduling change.
        if Thread.isMainThread {
            onChange()
        } else {
            DispatchQueue.main.async { [weak self] in self?.onChange() }
        }
    }
}
