//
//  teminali-pointer — the studio's eyes and hand on macOS.
//
//  Everything the voice assistant knows about the screen, and everything it
//  does to the screen, goes through this one binary. It exists because the two
//  capabilities it wraps are not reachable from Node at all: the accessibility
//  tree (AXUIElement) and synthetic input (CGEvent).
//
//  The governing decision is in `tree`. A vision model asked to name pixel
//  coordinates from a screenshot will confidently produce numbers that are
//  close, and "close" in agent mode means clicking the row below the one you
//  asked for. So the model is never shown coordinates and never asked for
//  them: this command enumerates the real elements the OS reports — role,
//  title, enabled state and exact frame — the model picks one by name, and the
//  frame the OS gave us is what gets clicked. The screenshot is context for
//  reasoning, not the source of geometry.
//
//  Output is one JSON object on stdout, always, including for failures. Exit
//  code 0 means "the answer is below"; a non-zero code means the answer is an
//  `error` object. Nothing is ever written to stdout that is not JSON, because
//  the only caller parses it.
//
//  Coordinate space: AXPosition and CGEvent both use the Quartz global display
//  space — origin at the top-left of the primary display, y increasing
//  downward. They agree, so no flipping happens anywhere in this file. (NSScreen
//  does not agree; it is deliberately not used for geometry.)
//

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Output

func emit(_ payload: [String: Any], status: Int32 = 0) -> Never {
    // .sortedKeys keeps the output diffable when a human is reading it in a
    // terminal; the parser does not care either way.
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        ?? Data(#"{"error":{"code":"ENCODE_FAILED","message":"The result could not be encoded."}}"#.utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(status)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["error": ["code": code, "message": message]], status: 1)
}

// MARK: - Arguments

/// `--flag value` pairs. Deliberately not a general parser: every caller is
/// this repository's own gateway, and an unknown flag is a bug worth failing on.
struct Args {
    private let map: [String: String]
    let command: String

    init(_ argv: [String]) {
        command = argv.count > 1 ? argv[1] : ""
        var parsed: [String: String] = [:]
        var index = 2
        while index < argv.count {
            let token = argv[index]
            guard token.hasPrefix("--") else { index += 1; continue }
            let key = String(token.dropFirst(2))
            if index + 1 < argv.count, !argv[index + 1].hasPrefix("--") {
                parsed[key] = argv[index + 1]
                index += 2
            } else {
                parsed[key] = "true"
                index += 1
            }
        }
        map = parsed
    }

    func string(_ key: String) -> String? { map[key] }
    func double(_ key: String) -> Double? { map[key].flatMap(Double.init) }
    func int(_ key: String) -> Int? { map[key].flatMap(Int.init) }
    func flag(_ key: String) -> Bool { map[key] == "true" }
}

let args = Args(CommandLine.arguments)

// MARK: - Permissions

/// Neither of these can be granted programmatically, and pretending otherwise
/// is how an assistant ends up silently doing nothing. Both are reported as
/// they are so the interface can say which switch the operator has to flip.
func accessibilityTrusted(prompt: Bool) -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func screenRecordingGranted() -> Bool {
    CGPreflightScreenCaptureAccess()
}

// MARK: - Geometry

func screens() -> [[String: Any]] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }

    return ids.map { id in
        let bounds = CGDisplayBounds(id)
        let mode = CGDisplayCopyDisplayMode(id)
        // The backing scale is pixelWidth / pointWidth. Reported so the caller
        // can reconcile a Retina screenshot's pixels with the point-space
        // frames every element below is measured in.
        let scale = mode.map { Double($0.pixelWidth) / Double(max(1, $0.width)) } ?? 1
        return [
            "id": Int(id),
            "main": CGDisplayIsMain(id) != 0,
            "x": bounds.origin.x, "y": bounds.origin.y,
            "width": bounds.size.width, "height": bounds.size.height,
            "scale": scale,
        ]
    }
}

// MARK: - Accessibility tree

let INTERACTIVE_ROLES: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
    "AXMenuItem", "AXMenuBarItem", "AXTextField", "AXTextArea", "AXSearchField",
    "AXSecureTextField", "AXComboBox", "AXSlider", "AXIncrementor", "AXStepper",
    "AXLink", "AXTab", "AXTabGroup", "AXRow", "AXCell", "AXDisclosureTriangle",
    "AXColorWell", "AXSegmentedControl", "AXToolbar", "AXScrollBar", "AXSwitch",
    "AXCheckBoxButton", "AXOutline", "AXTable", "AXList", "AXScrollArea",
]

func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let raw = copyAttribute(element, name) else { return nil }
    if let text = raw as? String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    // AXValue attributes (a slider's number, a checkbox's 0/1) are legitimate
    // labels too; anything else is a element reference we have no use for.
    if let number = raw as? NSNumber { return number.stringValue }
    return nil
}

func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? {
    (copyAttribute(element, name) as? NSNumber)?.boolValue
}

func frame(of element: AXUIElement) -> CGRect? {
    guard let positionRef = copyAttribute(element, kAXPositionAttribute as String),
          let sizeRef = copyAttribute(element, kAXSizeAttribute as String),
          CFGetTypeID(positionRef) == AXValueGetTypeID(),
          CFGetTypeID(sizeRef) == AXValueGetTypeID()
    else { return nil }

    var origin = CGPoint.zero
    var size = CGSize.zero
    // swiftlint:disable:next force_cast — the type id was just checked.
    guard AXValueGetValue(positionRef as! AXValue, .cgPoint, &origin),
          AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
    else { return nil }
    return CGRect(origin: origin, size: size)
}

func actionNames(of element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let list = names as? [String]
    else { return [] }
    return list
}

/// The best human-readable name for an element, in the order a person would
/// read one: what it says, then what it is described as, then what it holds.
func label(of element: AXUIElement) -> String? {
    stringAttribute(element, kAXTitleAttribute as String)
        ?? stringAttribute(element, kAXDescriptionAttribute as String)
        ?? stringAttribute(element, "AXLabel")
        ?? stringAttribute(element, kAXValueAttribute as String)
        ?? stringAttribute(element, kAXHelpAttribute as String)
        ?? stringAttribute(element, kAXPlaceholderValueAttribute as String)
}

struct Node {
    let element: AXUIElement
    let depth: Int
    let path: [String]
}

/// Depth-first walk with two separate budgets.
///
/// `visitLimit` bounds the cost of the walk — a browser's rendered document can
/// run to tens of thousands of nodes and the assistant must answer in under a
/// second. `emitLimit` bounds what comes back, and only elements that are
/// actually addressable (interactive role, or named and visible) are emitted at
/// all. A group with no title that exists to hold a stack view is real, but no
/// instruction ever refers to it.
func walk(root: AXUIElement, visitLimit: Int, emitLimit: Int, depthLimit: Int) -> ([[String: Any]], Bool) {
    var emitted: [[String: Any]] = []
    var visited = 0
    var truncated = false
    var stack = [Node(element: root, depth: 0, path: [])]

    while let node = stack.popLast() {
        if visited >= visitLimit { truncated = true; break }
        visited += 1

        let element = node.element
        let role = stringAttribute(element, kAXRoleAttribute as String) ?? "AXUnknown"
        let name = label(of: element)
        let box = frame(of: element)

        // Zero-area elements cannot be pointed at or clicked, and an offscreen
        // one is not on the screen the operator is looking at.
        let visible = (box?.width ?? 0) >= 1 && (box?.height ?? 0) >= 1
        let addressable = visible && (INTERACTIVE_ROLES.contains(role) || name != nil)

        if addressable, emitted.count < emitLimit, let box {
            let subrole = stringAttribute(element, kAXSubroleAttribute as String)
            let actions = actionNames(of: element)
            var record: [String: Any] = [
                "id": "e\(emitted.count)",
                "role": role,
                "frame": ["x": box.origin.x, "y": box.origin.y, "width": box.size.width, "height": box.size.height],
                "enabled": boolAttribute(element, kAXEnabledAttribute as String) ?? true,
                "focused": boolAttribute(element, kAXFocusedAttribute as String) ?? false,
                "actions": actions,
                "depth": node.depth,
                "path": node.path.suffix(4).joined(separator: " › "),
            ]
            if let name { record["label"] = name }
            if let subrole { record["subrole"] = subrole }
            if let value = stringAttribute(element, kAXValueAttribute as String), value != name {
                record["value"] = String(value.prefix(160))
            }
            emitted.append(record)
        } else if addressable, emitted.count >= emitLimit {
            truncated = true
        }

        guard node.depth < depthLimit else { continue }
        guard let children = copyAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else { continue }

        let breadcrumb = node.path + [name.map { "\(role):\($0)" } ?? role]
        // Reversed so the popLast() stack yields children in their natural
        // order — which is reading order, and therefore the order a person
        // would describe them in.
        for child in children.reversed() {
            stack.append(Node(element: child, depth: node.depth + 1, path: breadcrumb))
        }
    }

    return (emitted, truncated)
}

func frontmostApplication() -> NSRunningApplication? {
    NSWorkspace.shared.frontmostApplication
}

// MARK: - Input synthesis

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
}

func move(to point: CGPoint) {
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
}

func click(at point: CGPoint, button: CGMouseButton, count: Int) {
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    // Moving first matters: some applications track the pointer rather than the
    // click location, and a click that teleports lands on a control that never
    // saw a hover.
    move(to: point)
    for index in 1...max(1, count) {
        let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)
        // The click count is what turns two clicks into a double-click rather
        // than two single ones.
        downEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        post(downEvent)
        let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)
        upEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        post(upEvent)
    }
}

/// A drag is not a click with a different destination.
///
/// An application that implements one watches the stream of `mouseDragged`
/// events between the press and the release: a slider reads each intermediate
/// position, a list reorders against the row currently under the pointer, a
/// selection rectangle is drawn from the path. Posting only a down at the
/// origin and an up at the target gives all of them nothing to work with, and
/// the gesture silently does nothing at all. So the path is walked, and the
/// press is held long enough to be registered as a pickup rather than a click.
func drag(from origin: CGPoint, to destination: CGPoint, button: CGMouseButton, steps: Int, holdMs: Int) {
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let dragged: CGEventType = button == .right ? .rightMouseDragged : .leftMouseDragged
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    let hold = useconds_t(max(0, holdMs) * 1000)

    move(to: origin)
    let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: origin, mouseButton: button)
    downEvent?.setIntegerValueField(.mouseEventClickState, value: 1)
    post(downEvent)
    usleep(hold)

    let count = max(1, steps)
    for index in 1...count {
        let progress = Double(index) / Double(count)
        let point = CGPoint(
            x: origin.x + (destination.x - origin.x) * progress,
            y: origin.y + (destination.y - origin.y) * progress
        )
        let move = CGEvent(mouseEventSource: nil, mouseType: dragged, mouseCursorPosition: point, mouseButton: button)
        move?.setIntegerValueField(.mouseEventClickState, value: 1)
        post(move)
        usleep(8000)
    }

    // Released where the last drag event landed, not where the caller asked, so
    // the two can never disagree by a rounding error.
    usleep(hold)
    let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: destination, mouseButton: button)
    upEvent?.setIntegerValueField(.mouseEventClickState, value: 1)
    post(upEvent)
}

func scroll(at point: CGPoint, dx: Int32, dy: Int32) {
    move(to: point)
    post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
}

/// Typing goes through the Unicode payload rather than a keycode table, which
/// is the only way an arbitrary string — an accented name, a path, a sentence
/// of Kiswahili — arrives intact regardless of the active keyboard layout.
func type(_ text: String) {
    for chunk in Array(text.utf16).chunked(into: 16) {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { continue }
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(down)
        post(up)
        usleep(1200)
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

let KEY_CODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

let MODIFIERS: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand,
    "shift": .maskShift,
    "ctrl": .maskControl, "control": .maskControl,
    "alt": .maskAlternate, "opt": .maskAlternate, "option": .maskAlternate,
]

/// A chord is `cmd+shift+p`. Unknown names are rejected rather than dropped:
/// silently sending ⌘P when ⌘⇧P was asked for is worse than not sending it.
func pressChord(_ chord: String) throws {
    var flags = CGEventFlags()
    var key: CGKeyCode?

    for part in chord.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        if let modifier = MODIFIERS[part] {
            flags.insert(modifier)
        } else if let code = KEY_CODES[part] {
            guard key == nil else { throw PointerError.badChord("A chord may name only one non-modifier key.") }
            key = code
        } else {
            throw PointerError.badChord("Unknown key \"\(part)\" in chord \"\(chord)\".")
        }
    }
    guard let key else { throw PointerError.badChord("The chord \"\(chord)\" names no key to press.") }

    let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)
    down?.flags = flags
    post(down)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
    up?.flags = flags
    post(up)
}

enum PointerError: Error {
    case badChord(String)
}

// MARK: - Commands

/// Every acting command is gated here rather than at each call site, so a new
/// verb cannot be added that forgets to check.
func requireAccessibility() {
    guard accessibilityTrusted(prompt: false) else {
        fail("ACCESSIBILITY_DENIED", "Accessibility access has not been granted to this application.")
    }
}

func requirePoint() -> CGPoint {
    guard let x = args.double("x"), let y = args.double("y") else {
        fail("POINT_REQUIRED", "Both --x and --y are required.")
    }
    return CGPoint(x: x, y: y)
}

switch args.command {
case "permissions":
    emit([
        "accessibilityTrusted": accessibilityTrusted(prompt: args.flag("prompt")),
        "screenRecordingGranted": screenRecordingGranted(),
        "platform": "darwin",
        "version": ProcessInfo.processInfo.operatingSystemVersionString,
    ])

case "screens":
    emit(["screens": screens()])

case "frontmost":
    // Cheap enough to call before every action. The gateway uses it to refuse
    // an action whose observation was taken of a different application — a
    // frame that was correct for the window you were looking at a moment ago is
    // simply a coordinate on top of whatever replaced it.
    guard let application = frontmostApplication() else {
        fail("NO_TARGET_APPLICATION", "No frontmost application could be identified.")
    }
    emit([
        "application": [
            "name": application.localizedName ?? "Unknown",
            "bundleId": application.bundleIdentifier ?? "",
            "pid": Int(application.processIdentifier),
        ],
    ])

case "cursor":
    guard let event = CGEvent(source: nil) else { fail("CURSOR_UNAVAILABLE", "The pointer location could not be read.") }
    let location = event.location
    emit(["cursor": ["x": location.x, "y": location.y]])

case "tree":
    requireAccessibility()
    let application: NSRunningApplication?
    if let pid = args.int("pid") {
        application = NSRunningApplication(processIdentifier: pid_t(pid))
    } else {
        application = frontmostApplication()
    }
    guard let application, let bundle = application.processIdentifier as pid_t? else {
        fail("NO_TARGET_APPLICATION", "No frontmost application could be identified.")
    }

    let root = AXUIElementCreateApplication(bundle)
    let (elements, truncated) = walk(
        root: root,
        visitLimit: args.int("visit") ?? 6000,
        emitLimit: args.int("max") ?? 400,
        depthLimit: args.int("depth") ?? 18
    )

    // The focused window is what the operator is actually looking at; naming it
    // lets the caller rank elements inside it above the rest of the app.
    var windowTitle: String?
    var windowFrame: [String: Any]?
    if let window = copyAttribute(root, kAXFocusedWindowAttribute as String) {
        // swiftlint:disable:next force_cast — AX always hands back an element here.
        let windowElement = window as! AXUIElement
        windowTitle = stringAttribute(windowElement, kAXTitleAttribute as String)
        if let box = frame(of: windowElement) {
            windowFrame = ["x": box.origin.x, "y": box.origin.y, "width": box.size.width, "height": box.size.height]
        }
    }

    var payload: [String: Any] = [
        "application": [
            "name": application.localizedName ?? "Unknown",
            "bundleId": application.bundleIdentifier ?? "",
            "pid": Int(bundle),
        ],
        "elements": elements,
        "truncated": truncated,
        "screens": screens(),
    ]
    var window: [String: Any] = [:]
    if let windowTitle { window["title"] = windowTitle }
    if let windowFrame { window["frame"] = windowFrame }
    if !window.isEmpty { payload["window"] = window }
    emit(payload)

case "move":
    requireAccessibility()
    let point = requirePoint()
    move(to: point)
    emit(["moved": ["x": point.x, "y": point.y]])

case "click":
    requireAccessibility()
    let point = requirePoint()
    let button: CGMouseButton = args.string("button") == "right" ? .right : .left
    let count = min(3, max(1, args.int("count") ?? 1))
    click(at: point, button: button, count: count)
    emit(["clicked": ["x": point.x, "y": point.y, "count": count, "button": args.string("button") ?? "left"]])

case "drag":
    requireAccessibility()
    let origin = requirePoint()
    guard let toX = args.double("tox"), let toY = args.double("toy") else {
        fail("DESTINATION_REQUIRED", "Both --tox and --toy are required.")
    }
    let destination = CGPoint(x: toX, y: toY)
    let dragButton: CGMouseButton = args.string("button") == "right" ? .right : .left
    let dragSteps = min(200, max(2, args.int("steps") ?? 24))
    let holdMs = min(2000, max(0, args.int("holdms") ?? 90))
    drag(from: origin, to: destination, button: dragButton, steps: dragSteps, holdMs: holdMs)
    emit([
        "dragged": [
            "from": ["x": origin.x, "y": origin.y],
            "to": ["x": destination.x, "y": destination.y],
            "button": args.string("button") == "right" ? "right" : "left",
            "steps": dragSteps,
        ],
    ])

case "scroll":
    requireAccessibility()
    let point = requirePoint()
    let dx = Int32(clamping: args.int("dx") ?? 0)
    let dy = Int32(clamping: args.int("dy") ?? 0)
    scroll(at: point, dx: dx, dy: dy)
    emit(["scrolled": ["x": point.x, "y": point.y, "dx": Int(dx), "dy": Int(dy)]])

case "type":
    requireAccessibility()
    guard let text = args.string("text") else { fail("TEXT_REQUIRED", "--text is required.") }
    guard text.count <= 4000 else { fail("TEXT_TOO_LONG", "The text to type exceeds 4000 characters.") }
    type(text)
    emit(["typed": ["characters": text.count]])

case "key":
    requireAccessibility()
    guard let chord = args.string("chord") else { fail("CHORD_REQUIRED", "--chord is required.") }
    do {
        try pressChord(chord)
        emit(["pressed": ["chord": chord]])
    } catch PointerError.badChord(let message) {
        fail("INVALID_CHORD", message)
    } catch {
        fail("KEY_FAILED", "The chord could not be sent.")
    }

case "activate":
    // Addressable three ways because the callers know three different things.
    // The gateway restores an observation's own application and knows its pid.
    // A `focus` on a curated application knows its bundle id, because the whole
    // point is that it is somebody else's process. And a `focus` on an
    // application discovered by scanning /Applications knows only the display
    // name on the bundle — that is all `open -a` needed to start it, so it has
    // to be enough to bring it forward too.
    let target: NSRunningApplication?
    if let pid = args.int("pid") {
        target = NSRunningApplication(processIdentifier: pid_t(pid))
    } else if let bundle = args.string("bundle") {
        // Newest first: when an application is somehow running twice, the one
        // the operator most recently started is the one they mean.
        target = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
            .sorted { ($0.launchDate ?? .distantPast) > ($1.launchDate ?? .distantPast) }
            .first
    } else if let name = args.string("name") {
        let wanted = name.lowercased()
        target = NSWorkspace.shared.runningApplications
            .filter { ($0.localizedName ?? "").lowercased() == wanted }
            .sorted { ($0.launchDate ?? .distantPast) > ($1.launchDate ?? .distantPast) }
            .first
    } else {
        fail("PID_REQUIRED", "One of --pid, --bundle or --name is required.")
    }
    if let app = target {
        let ok = app.activate(options: [.activateIgnoringOtherApps])
        emit([
            "activated": ok,
            "name": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
        ])
    } else {
        fail("APP_NOT_RUNNING", "That application is not running.")
    }

default:
    fail(
        "UNKNOWN_COMMAND",
        "Expected one of: permissions, screens, cursor, frontmost, tree, move, click, drag, scroll, type, key, activate."
    )
}
