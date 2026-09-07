import AppKit
import Carbon.HIToolbox

// Global hotkeys via Carbon RegisterEventHotKey. Chosen over an NSEvent global
// monitor (passive, can't act cleanly) or a CGEvent tap (needs Input-Monitoring
// TCC and can be disabled under load): RegisterEventHotKey needs NO extra TCC to
// register, and because we use DEDICATED chords (Cmd-Shift-V, Cmd-Shift-O) we
// never hijack the OS Cmd-V. The Accessibility grant is only needed later, for
// the paste injection itself (Clip.inject).
//
// Two chords are demultiplexed through ONE installed handler by reading the
// fired EventHotKeyID.id and routing to a static dispatch table — the
// InstallEventHandler callback is a bare C function pointer with no captured
// context, so per-instance closures can't be reached any other way.
final class HotkeyManager {
    // A chord to register and the action it fires.
    struct Binding {
        let id: UInt32          // EventHotKeyID.id, namespaced under 'AGCT'
        let keyCode: UInt32     // e.g. UInt32(kVK_ANSI_V)
        let modifiers: UInt32   // e.g. UInt32(cmdKey | shiftKey)
        let label: String       // human name for the chord, e.g. "Cmd-Shift-V"
        let onFire: () -> Void
    }

    // Stable ids so main.swift and this file can't drift.
    static let clipID: UInt32 = 1     // Cmd-Shift-V → Clip.run()
    static let promptID: UInt32 = 2   // Cmd-Shift-O → prompt panel
    static let sessionsID: UInt32 = 3 // Cmd-Shift-I → Sessions window

    // Demux table: EventHotKeyID.id → action. Static for the same reason the old
    // `shared` was — the C callback has no context pointer.
    private static var handlers: [UInt32: () -> Void] = [:]

    private var hotKeyRefs: [EventHotKeyRef?] = []
    private var handlerRef: EventHandlerRef?

    func register(_ bindings: [Binding]) {
        for b in bindings { HotkeyManager.handlers[b.id] = b.onFire }

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            // Read which chord fired and route to its action.
            var hkID = EventHotKeyID()
            let status = GetEventParameter(event,
                                           EventParamName(kEventParamDirectObject),
                                           EventParamType(typeEventHotKeyID),
                                           nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            if status == noErr { HotkeyManager.handlers[hkID.id]?() }
            return noErr
        }, 1, &spec, nil, &handlerRef)

        // 'AGCT' signature keeps our hotkey ids namespaced from other apps'.
        let signature = OSType(0x41474354)
        for b in bindings {
            var ref: EventHotKeyRef?
            let registered = RegisterEventHotKey(b.keyCode, b.modifiers,
                                                 EventHotKeyID(signature: signature, id: b.id),
                                                 GetApplicationEventTarget(), 0, &ref)
            hotKeyRefs.append(ref)
            // Registration fails if another app already owns the chord. stderr
            // goes to the launchd log, which nobody reads — a stolen Cmd-Shift-V
            // then looks exactly like a broken paste. Notify as well, naming the
            // chord, so the conflict is visible where the user is.
            if registered != noErr {
                FileHandle.standardError.write(Data(
                    "hotkey: registration failed id=\(b.id) (register=\(registered))\n".utf8))
                Notifier.post(
                    title: "Hotkey unavailable",
                    body: "\(b.label) is already registered by another app, so it will not work here. "
                        + "A second copy of the menu bar helper is the usual cause — "
                        + "check it with `agents menubar status`.",
                    subtitle: b.label)
            }
        }

        if installed != noErr {
            FileHandle.standardError.write(Data(
                "hotkey: handler install failed (install=\(installed))\n".utf8))
        }
    }
}
