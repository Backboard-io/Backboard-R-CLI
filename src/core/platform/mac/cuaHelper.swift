// Backboard computer-use helper for macOS.
//
// A long-lived process that speaks JSON lines over stdin/stdout. One request
// per line ({"id":..,"op":..,...}); one response per line ({"id":..,"ok":..}).
// It is compiled once with `swiftc` and cached under ~/.backboard/bin so the
// CLI never pays the `swift -e` JIT cost per action.
//
// Coordinate contract: every point the helper accepts or returns is in the
// *point* space of the target display (the display that holds the frontmost
// window), origin top-left. Screenshots may be downscaled; the response carries
// `scale = imageWidth / pointWidth` so callers can map between the two.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - Protocol

struct HelperError: Error {
	let message: String
	init(_ message: String) { self.message = message }
}

let stdout = FileHandle.standardOutput
let outputLock = NSLock()

func emit(_ payload: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
	outputLock.lock()
	stdout.write(data)
	stdout.write("\n".data(using: .utf8)!)
	outputLock.unlock()
}

func respond(id: Any, _ body: [String: Any]) {
	var payload = body
	payload["id"] = id
	payload["ok"] = true
	emit(payload)
}

func fail(id: Any, _ message: String) {
	emit(["id": id, "ok": false, "error": message])
}

func num(_ params: [String: Any], _ key: String) -> Double? {
	if let value = params[key] as? Double { return value }
	if let value = params[key] as? Int { return Double(value) }
	if let value = params[key] as? NSNumber { return value.doubleValue }
	return nil
}

func str(_ params: [String: Any], _ key: String) -> String? {
	return params[key] as? String
}

// MARK: - Display

struct TargetDisplay {
	let id: CGDirectDisplayID
	let bounds: CGRect  // global points, top-left origin
	let pixelWidth: Int
	let pixelHeight: Int
	var scale: Double { Double(pixelWidth) / Double(bounds.width) }

	func toGlobal(_ x: Double, _ y: Double) -> CGPoint {
		return CGPoint(x: bounds.origin.x + x, y: bounds.origin.y + y)
	}

	var json: [String: Any] {
		return [
			"displayId": Int(id),
			"origin": ["x": bounds.origin.x, "y": bounds.origin.y],
			"points": ["width": bounds.width, "height": bounds.height],
			"pixels": ["width": pixelWidth, "height": pixelHeight],
			"scale": scale,
		]
	}
}

func makeDisplay(_ id: CGDirectDisplayID) -> TargetDisplay {
	return TargetDisplay(
		id: id,
		bounds: CGDisplayBounds(id),
		pixelWidth: CGDisplayPixelsWide(id),
		pixelHeight: CGDisplayPixelsHigh(id))
}

func frontmostWindowFrame() -> CGRect? {
	guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
	let root = AXUIElementCreateApplication(app.processIdentifier)
	guard let window = focusedWindow(of: root) else { return nil }
	return axFrame(window)
}

func targetDisplay(explicit: Int?) -> TargetDisplay {
	if let explicit, explicit > 0 {
		return makeDisplay(CGDirectDisplayID(explicit))
	}
	if let frame = frontmostWindowFrame(), frame.width > 0 {
		let center = CGPoint(x: frame.midX, y: frame.midY)
		var ids = [CGDirectDisplayID](repeating: 0, count: 16)
		var count: UInt32 = 0
		if CGGetDisplaysWithPoint(center, 16, &ids, &count) == .success, count > 0 {
			return makeDisplay(ids[0])
		}
		if CGGetDisplaysWithRect(frame, 16, &ids, &count) == .success, count > 0 {
			return makeDisplay(ids[0])
		}
	}
	return makeDisplay(CGMainDisplayID())
}

// MARK: - Capture

var cachedDisplays: [CGDirectDisplayID: AnyObject] = [:]

@available(macOS 14.0, *)
func shareableDisplay(_ id: CGDirectDisplayID, refresh: Bool) async throws -> SCDisplay? {
	if !refresh, let cached = cachedDisplays[id] as? SCDisplay { return cached }
	let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
	cachedDisplays = [:]
	for display in content.displays { cachedDisplays[display.displayID] = display }
	return cachedDisplays[id] as? SCDisplay
}

/// Captures one display via ScreenCaptureKit. `width`/`height` let SCK render
/// the frame at a reduced size directly (cheap thumbnails for settle polling).
func captureDisplayImage(_ display: TargetDisplay, width: Int? = nil, height: Int? = nil) throws -> CGImage {
	guard #available(macOS 14.0, *) else {
		throw HelperError("Computer use requires macOS 14 or newer")
	}
	let semaphore = DispatchSemaphore(value: 0)
	var result: CGImage?
	var failure: String?
	Task {
		defer { semaphore.signal() }
		do {
			var scDisplay = try await shareableDisplay(display.id, refresh: false)
			if scDisplay == nil { scDisplay = try await shareableDisplay(display.id, refresh: true) }
			guard let scDisplay else {
				failure = "Display \(display.id) is not available for capture"
				return
			}
			let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
			let config = SCStreamConfiguration()
			config.width = width ?? display.pixelWidth
			config.height = height ?? display.pixelHeight
			config.showsCursor = true
			config.captureResolution = .best
			result = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
		} catch {
			failure = "\(error.localizedDescription)"
		}
	}
	_ = semaphore.wait(timeout: .now() + 8)
	if let result { return result }
	throw HelperError(
		"Screen capture failed\(failure.map { ": \($0)" } ?? ""). Grant Screen Recording permission to your terminal in System Settings > Privacy & Security > Screen Recording.")
}

func resize(_ image: CGImage, toWidth width: Int) -> CGImage? {
	if image.width <= width { return image }
	let height = Int((Double(image.height) * Double(width) / Double(image.width)).rounded())
	guard
		let context = CGContext(
			data: nil, width: width, height: max(height, 1), bitsPerComponent: 8, bytesPerRow: 0,
			space: CGColorSpaceCreateDeviceRGB(),
			bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)
	else { return nil }
	context.interpolationQuality = .high
	context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: max(height, 1)))
	return context.makeImage()
}

func encode(_ image: CGImage, format: String, quality: Double, to path: String) throws -> Int {
	let url = URL(fileURLWithPath: path)
	let type: UTType = format == "jpeg" ? .jpeg : .png
	guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)
	else { throw HelperError("Could not create image destination at \(path)") }
	var options: [CFString: Any] = [:]
	if format == "jpeg" {
		options[kCGImageDestinationLossyCompressionQuality] = quality
	}
	CGImageDestinationAddImage(destination, image, options as CFDictionary)
	guard CGImageDestinationFinalize(destination) else {
		throw HelperError("Could not write screenshot to \(path)")
	}
	let attrs = try FileManager.default.attributesOfItem(atPath: path)
	return (attrs[.size] as? NSNumber)?.intValue ?? 0
}

func capture(params: [String: Any], display: TargetDisplay) throws -> [String: Any] {
	guard let path = str(params, "path") else { throw HelperError("capture requires path") }
	let maxWidth = Int(num(params, "maxWidth") ?? 1280)
	let format = str(params, "format") ?? "png"
	let quality = num(params, "quality") ?? 0.85
	var image = try captureDisplayImage(display)
	var regionJson: [String: Any]? = nil
	if let region = params["region"] as? [String: Any],
		let x = num(region, "x"), let y = num(region, "y"),
		let w = num(region, "width"), let h = num(region, "height"), w > 0, h > 0
	{
		let scale = display.scale
		let rect = CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale)
			.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
		guard !rect.isNull, rect.width >= 1, rect.height >= 1, let cropped = image.cropping(to: rect)
		else { throw HelperError("zoom region is outside the screen") }
		image = cropped
		regionJson = ["x": rect.origin.x / scale, "y": rect.origin.y / scale, "width": rect.width / scale, "height": rect.height / scale]
	}
	let sourcePointWidth = regionJson.map { $0["width"] as! Double } ?? display.bounds.width
	guard let resized = resize(image, toWidth: min(maxWidth, image.width)) else {
		throw HelperError("Could not resize screenshot")
	}
	let bytes = try encode(resized, format: format, quality: quality, to: path)
	var json: [String: Any] = [
		"path": path,
		"bytes": bytes,
		"format": format,
		"imageSize": ["width": resized.width, "height": resized.height],
		"screenSize": ["width": display.bounds.width, "height": display.bounds.height],
		"scale": Double(resized.width) / sourcePointWidth,
		"display": display.json,
	]
	if let regionJson { json["region"] = regionJson }
	return json
}

// MARK: - Settle (wait until the screen stops changing)

func thumbnailBytes(_ display: TargetDisplay) -> [UInt8]? {
	let width = 96
	let height = max(1, Int((Double(display.pixelHeight) * Double(width) / Double(display.pixelWidth)).rounded()))
	guard let image = try? captureDisplayImage(display, width: width, height: height),
		let data = image.dataProvider?.data
	else { return nil }
	return [UInt8](data as Data)
}

/// Two thumbnails "match" when fewer than `tolerance` of their bytes moved by
/// more than a small amount — blinking cursors and spinners must not keep the
/// screen "unsettled" forever.
func framesMatch(_ a: [UInt8], _ b: [UInt8], tolerance: Double) -> Bool {
	guard a.count == b.count, !a.isEmpty else { return false }
	var changed = 0
	for index in 0..<a.count where abs(Int(a[index]) - Int(b[index])) > 24 {
		changed += 1
	}
	return Double(changed) / Double(a.count) <= tolerance
}

func settle(params: [String: Any], display: TargetDisplay) -> [String: Any] {
	let timeoutMs = num(params, "timeoutMs") ?? 1500
	let intervalMs = num(params, "intervalMs") ?? 100
	let initialDelayMs = num(params, "initialDelayMs") ?? 50
	let start = Date()
	Thread.sleep(forTimeInterval: initialDelayMs / 1000)
	var previous = thumbnailBytes(display)
	var frames = 1
	while Date().timeIntervalSince(start) * 1000 < timeoutMs {
		Thread.sleep(forTimeInterval: intervalMs / 1000)
		let current = thumbnailBytes(display)
		frames += 1
		if let previous, let current, framesMatch(previous, current, tolerance: num(params, "tolerance") ?? 0.004) {
			return ["settled": true, "elapsedMs": Int(Date().timeIntervalSince(start) * 1000), "frames": frames]
		}
		previous = current
	}
	return ["settled": false, "elapsedMs": Int(Date().timeIntervalSince(start) * 1000), "frames": frames]
}

// MARK: - Accessibility

let interactiveRoles: Set<String> = [
	"AXButton", "AXPopUpButton", "AXMenuButton", "AXCheckBox", "AXRadioButton", "AXTextField",
	"AXTextArea", "AXSecureTextField", "AXComboBox", "AXLink", "AXMenuItem", "AXMenuBarItem",
	"AXRow", "AXCell", "AXStaticText", "AXImage", "AXSlider", "AXIncrementor",
	"AXDisclosureTriangle", "AXOutlineRow", "AXSearchField", "AXSwitch", "AXTabGroup",
	"AXToolbar", "AXColorWell", "AXDateField", "AXTimeField", "AXHeading", "AXWindow",
	"AXSheet", "AXDialog", "AXPopover", "AXDockItem", "AXList", "AXTable", "AXOutline",
]

let containerOnlyRoles: Set<String> = ["AXWindow", "AXSheet", "AXDialog", "AXPopover", "AXList", "AXTable", "AXOutline", "AXTabGroup", "AXToolbar"]

func axValue(_ element: AXUIElement, _ attr: String) -> AnyObject? {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else { return nil }
	return value
}

func axString(_ element: AXUIElement, _ attr: String) -> String? {
	guard let raw = axValue(element, attr) else { return nil }
	if let text = raw as? String { return text.isEmpty ? nil : text }
	if let number = raw as? NSNumber { return number.stringValue }
	return nil
}

func axBool(_ element: AXUIElement, _ attr: String) -> Bool? {
	guard let raw = axValue(element, attr) else { return nil }
	return (raw as? NSNumber)?.boolValue
}

func axFrame(_ element: AXUIElement) -> CGRect? {
	guard let posRaw = axValue(element, kAXPositionAttribute), let sizeRaw = axValue(element, kAXSizeAttribute),
		CFGetTypeID(posRaw) == AXValueGetTypeID(), CFGetTypeID(sizeRaw) == AXValueGetTypeID()
	else { return nil }
	var point = CGPoint.zero
	var size = CGSize.zero
	// swiftlint:disable force_cast
	AXValueGetValue(posRaw as! AXValue, .cgPoint, &point)
	AXValueGetValue(sizeRaw as! AXValue, .cgSize, &size)
	// swiftlint:enable force_cast
	guard size.width > 0, size.height > 0 else { return nil }
	return CGRect(origin: point, size: size)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
	if let visible = axValue(element, "AXVisibleChildren") as? [AXUIElement], !visible.isEmpty {
		return visible
	}
	return (axValue(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func focusedWindow(of app: AXUIElement) -> AXUIElement? {
	if let raw = axValue(app, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
		// swiftlint:disable:next force_cast
		return (raw as! AXUIElement)
	}
	if let windows = axValue(app, kAXWindowsAttribute) as? [AXUIElement], let first = windows.first {
		return first
	}
	return nil
}

func clip(_ text: String, _ limit: Int) -> String {
	return text.count > limit ? String(text.prefix(limit)) + "…" : text
}

struct AXCollector {
	let display: TargetDisplay
	let maxElements: Int
	let maxDepth: Int
	let focusedElement: AXUIElement?
	var elements: [[String: Any]] = []
	var visited = 0
	var focusedId: String?

	mutating func collect(_ element: AXUIElement, depth: Int) {
		if elements.count >= maxElements || depth > maxDepth || visited > 4000 { return }
		visited += 1
		let role = axString(element, kAXRoleAttribute) ?? "AXUnknown"
		if role == "AXMenuBar" { return }
		if interactiveRoles.contains(role), !containerOnlyRoles.contains(role) || depth == 0,
			let frame = axFrame(element), frame.intersects(display.bounds)
		{
			var item: [String: Any] = [
				"id": "el_\(elements.count + 1)",
				"role": String(role.dropFirst(2)),
				"bounds": [
					"x": frame.origin.x - display.bounds.origin.x,
					"y": frame.origin.y - display.bounds.origin.y,
					"width": frame.width,
					"height": frame.height,
				],
			]
			let title = axString(element, kAXTitleAttribute)
			let description = axString(element, kAXDescriptionAttribute)
			let value = axString(element, kAXValueAttribute)
			let placeholder = axString(element, "AXPlaceholderValue")
			if let name = title ?? description ?? placeholder ?? (role == "AXStaticText" ? value : nil) {
				item["name"] = clip(name, 120)
			}
			if role != "AXStaticText", let value { item["value"] = clip(value, 120) }
			if let enabled = axBool(element, kAXEnabledAttribute), !enabled { item["enabled"] = false }
			if let focusedElement, CFEqual(focusedElement, element) {
				item["focused"] = true
				focusedId = item["id"] as? String
			}
			if role == "AXStaticText" && item["name"] == nil { /* skip unnamed text */ } else {
				elements.append(item)
			}
		}
		for child in axChildren(element) {
			if elements.count >= maxElements { break }
			collect(child, depth: depth + 1)
		}
	}
}

func accessibilitySnapshot(params: [String: Any], display: TargetDisplay) -> [String: Any] {
	var payload: [String: Any] = ["elements": [], "trusted": AXIsProcessTrusted()]
	guard let app = NSWorkspace.shared.frontmostApplication else { return payload }
	payload["appName"] = app.localizedName ?? app.bundleIdentifier ?? ""
	payload["processId"] = Int(app.processIdentifier)
	let root = AXUIElementCreateApplication(app.processIdentifier)
	AXUIElementSetMessagingTimeout(root, 0.5)
	guard let window = focusedWindow(of: root) else { return payload }
	payload["windowTitle"] = axString(window, kAXTitleAttribute) ?? ""
	if let frame = axFrame(window) {
		payload["windowBounds"] = [
			"x": frame.origin.x - display.bounds.origin.x, "y": frame.origin.y - display.bounds.origin.y,
			"width": frame.width, "height": frame.height,
		]
	}
	var focused: AXUIElement? = nil
	if let raw = axValue(root, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
		// swiftlint:disable:next force_cast
		focused = (raw as! AXUIElement)
	}
	var collector = AXCollector(
		display: display, maxElements: Int(num(params, "maxElements") ?? 80),
		maxDepth: Int(num(params, "maxDepth") ?? 14), focusedElement: focused)
	collector.collect(window, depth: 0)
	// Sheets and dialogs are separate top-level elements. When the focused
	// "window" is itself a sheet, also include the document window behind it
	// (and its title) so the model sees both the modal and its context.
	let focusedRole = axString(window, kAXRoleAttribute) ?? ""
	if let windows = axValue(root, kAXWindowsAttribute) as? [AXUIElement] {
		for other in windows where !CFEqual(other, window) {
			let role = axString(other, kAXRoleAttribute) ?? ""
			let subrole = axString(other, kAXSubroleAttribute) ?? ""
			let isModal = role == "AXSheet" || subrole == "AXDialog" || subrole == "AXSystemDialog"
			let isMainWindow = focusedRole == "AXSheet" && role == "AXWindow" && axValue(other, "AXMain") as? Bool == true
			if isModal || isMainWindow {
				collector.collect(other, depth: 0)
				if isMainWindow, (payload["windowTitle"] as? String ?? "").isEmpty {
					payload["windowTitle"] = axString(other, kAXTitleAttribute) ?? ""
				}
			}
		}
	}
	if focusedRole == "AXSheet" { payload["modal"] = true }
	payload["elements"] = collector.elements
	if let focusedId = collector.focusedId { payload["focusedElementId"] = focusedId }
	return payload
}

// MARK: - Input

/// Layout-independent keys (function, navigation, modifiers). Character keys
/// are resolved through the active keyboard layout instead, because virtual
/// key codes are physical positions: on Colemak the QWERTY "N" key types "K".
let specialKeyCodes: [String: CGKeyCode] = [
	"ENTER": 36, "RETURN": 36, "TAB": 48, "SPACE": 49, "BACKSPACE": 51, "DELETE": 117,
	"FORWARDDELETE": 117, "ESC": 53, "ESCAPE": 53, "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
	"HOME": 115, "END": 119, "PAGEUP": 116, "PAGEDOWN": 121, "CAPSLOCK": 57, "INSERT": 114,
	"HELP": 114, "CLEAR": 71, "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
	"F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107,
	"F15": 113, "F16": 106, "F17": 64, "F18": 79, "F19": 80, "META": 55, "COMMAND": 55, "CMD": 55,
	"SHIFT": 56, "ALT": 58, "OPTION": 58, "CONTROL": 59, "CTRL": 59, "FN": 63,
	"KP_ENTER": 76, "KP_0": 82, "KP_1": 83, "KP_2": 84, "KP_3": 85, "KP_4": 86, "KP_5": 87,
	"KP_6": 88, "KP_7": 89, "KP_8": 91, "KP_9": 92,
]

/// QWERTY positions, used only when the active layout cannot be read.
let qwertyKeyCodes: [Character: CGKeyCode] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
	"w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
	"=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
	"p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
	".": 47, "`": 50,
]

struct LayoutKey {
	let code: CGKeyCode
	let shift: Bool
}

var layoutCache: [Character: LayoutKey] = [:]
var layoutCacheSource: String = ""

/// Builds character → key code for the current input source by asking the
/// layout what each physical key produces, unshifted and shifted.
func refreshLayoutCache() {
	guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return }
	let idPointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
	let sourceId = idPointer.map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
	if sourceId == layoutCacheSource, !layoutCache.isEmpty { return }
	guard let dataPointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return }
	let data = Unmanaged<CFData>.fromOpaque(dataPointer).takeUnretainedValue() as Data
	var cache: [Character: LayoutKey] = [:]
	data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
		guard let base = raw.baseAddress else { return }
		let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
		for shift in [false, true] {
			let modifiers: UInt32 = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
			for code in 0..<128 {
				var deadKeyState: UInt32 = 0
				var length = 0
				var chars = [UniChar](repeating: 0, count: 4)
				let status = UCKeyTranslate(
					layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers,
					UInt32(LMGetKbdType()), UInt32(kUCKeyTranslateNoDeadKeysMask),
					&deadKeyState, 4, &length, &chars)
				guard status == noErr, length == 1, let scalar = Unicode.Scalar(chars[0]) else { continue }
				let character = Character(scalar)
				if character.isLetter || character.isNumber || character.isPunctuation || character.isSymbol {
					if cache[character] == nil { cache[character] = LayoutKey(code: CGKeyCode(code), shift: shift) }
				}
			}
		}
	}
	if !cache.isEmpty {
		layoutCache = cache
		layoutCacheSource = sourceId
	}
}

func resolveKey(_ raw: String) throws -> (code: CGKeyCode, shift: Bool) {
	let key = raw.uppercased()
	if let code = specialKeyCodes[key] { return (code, false) }
	if let code = specialKeyCodes[key.replacingOccurrences(of: "ARROW", with: "")] { return (code, false) }
	guard raw.count == 1, let character = raw.first else {
		throw HelperError("Unsupported key: \(raw)")
	}
	refreshLayoutCache()
	// Letters are sent by position; the caller adds shift explicitly.
	let lookup = character.isLetter ? Character(character.lowercased()) : character
	if let entry = layoutCache[lookup] { return (entry.code, entry.shift) }
	if let code = qwertyKeyCodes[lookup] { return (code, false) }
	if let base = shiftedSymbols[String(character)], let entry = layoutCache[Character(base)] ?? qwertyKeyCodes[Character(base)].map({ LayoutKey(code: $0, shift: false) }) {
		return (entry.code, true)
	}
	throw HelperError("Unsupported key: \(raw)")
}

let shiftedSymbols: [String: String] = [
	"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
	"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/",
	"~": "`",
]

func modifierFlag(_ modifier: String) -> (CGEventFlags, CGKeyCode)? {
	switch modifier.lowercased() {
	case "meta", "cmd", "command", "super", "win": return (.maskCommand, 55)
	case "control", "ctrl": return (.maskControl, 59)
	case "alt", "option": return (.maskAlternate, 58)
	case "shift": return (.maskShift, 56)
	case "fn": return (.maskSecondaryFn, 63)
	default: return nil
	}
}

func modifierFlags(_ modifiers: [String]) -> CGEventFlags {
	var flags = CGEventFlags()
	for modifier in modifiers {
		if let (flag, _) = modifierFlag(modifier) { flags.insert(flag) }
	}
	return flags
}

/// Holds modifiers around `body` by posting real modifier key-down/up events.
/// Setting `flags` on the key event alone is not enough: the window server
/// records the modifier as held and applies it to every later event, so a
/// `cmd+n` followed by typing "k" would send ⌘K.
func withModifiers(_ modifiers: [String], _ body: (CGEventFlags) -> Void) {
	var held: [(CGEventFlags, CGKeyCode)] = []
	var flags = CGEventFlags()
	for modifier in modifiers {
		guard let entry = modifierFlag(modifier), !flags.contains(entry.0) else { continue }
		flags.insert(entry.0)
		held.append(entry)
		post(CGEvent(keyboardEventSource: eventSource, virtualKey: entry.1, keyDown: true), flags: flags)
		sleepMs(4)
	}
	body(flags)
	for entry in held.reversed() {
		flags.remove(entry.0)
		post(CGEvent(keyboardEventSource: eventSource, virtualKey: entry.1, keyDown: false), flags: flags)
		sleepMs(4)
	}
}

func requireTrusted() throws {
	if !AXIsProcessTrusted() {
		throw HelperError(
			"Accessibility permission is required to control the computer. Enable your terminal in System Settings > Privacy & Security > Accessibility, then retry.")
	}
}

/// A private event source keeps our synthetic modifier state separate from
/// the HID session state: without it, a `cmd+n` key event leaves ⌘ "held"
/// for every event created afterwards, so typing "k" becomes ⌘K.
let eventSource = CGEventSource(stateID: .privateState)

func post(_ event: CGEvent?, flags: CGEventFlags = []) {
	guard let event else { return }
	event.flags = flags
	event.post(tap: .cghidEventTap)
}

func sleepMs(_ ms: Double) {
	Thread.sleep(forTimeInterval: ms / 1000)
}

func mouseButton(_ name: String) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
	switch name {
	case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
	case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
	default: return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
	}
}

func moveMouse(to point: CGPoint) {
	post(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
}

func click(params: [String: Any], display: TargetDisplay) throws {
	try requireTrusted()
	guard let x = num(params, "x"), let y = num(params, "y") else { throw HelperError("click requires x and y") }
	let point = display.toGlobal(x, y)
	let (button, downType, upType, _) = mouseButton(str(params, "button") ?? "left")
	let count = max(1, Int(num(params, "count") ?? 1))
	moveMouse(to: point)
	sleepMs(30)
	withModifiers((params["modifiers"] as? [String]) ?? []) { flags in
		for index in 1...count {
			let down = CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
			let up = CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
			down?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
			up?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
			post(down, flags: flags)
			sleepMs(15)
			post(up, flags: flags)
			if index < count { sleepMs(60) }
		}
	}
}

func drag(params: [String: Any], display: TargetDisplay) throws {
	try requireTrusted()
	guard let x1 = num(params, "fromX"), let y1 = num(params, "fromY"), let x2 = num(params, "toX"),
		let y2 = num(params, "toY")
	else { throw HelperError("drag requires fromX, fromY, toX, toY") }
	let from = display.toGlobal(x1, y1)
	let to = display.toGlobal(x2, y2)
	let (button, downType, upType, dragType) = mouseButton(str(params, "button") ?? "left")
	moveMouse(to: from)
	sleepMs(40)
	post(CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: from, mouseButton: button))
	sleepMs(60)
	let steps = 12
	for step in 1...steps {
		let t = Double(step) / Double(steps)
		let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
		post(CGEvent(mouseEventSource: eventSource, mouseType: dragType, mouseCursorPosition: point, mouseButton: button))
		sleepMs(16)
	}
	sleepMs(60)
	post(CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: to, mouseButton: button))
}

func scroll(params: [String: Any], display: TargetDisplay) throws {
	try requireTrusted()
	let dx = Int32(num(params, "dx") ?? 0)
	let dy = Int32(num(params, "dy") ?? 0)
	if let x = num(params, "x"), let y = num(params, "y") {
		moveMouse(to: display.toGlobal(x, y))
		sleepMs(30)
	}
	// CGEvent wheel1 > 0 scrolls the content up (toward the top of the page);
	// callers pass dy > 0 to mean "scroll down", so negate.
	let event = CGEvent(scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)
	post(event)
}

func typeText(params: [String: Any]) throws {
	try requireTrusted()
	guard let text = str(params, "text") else { throw HelperError("type requires text") }
	let scalars = Array(text.utf16)
	var index = 0
	while index < scalars.count {
		let end = min(index + 20, scalars.count)
		var chunk = Array(scalars[index..<end])
		if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true) {
			down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
			post(down)
		}
		if let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false) {
			up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
			post(up)
		}
		sleepMs(12)
		index = end
	}
}

func pressKey(params: [String: Any]) throws {
	try requireTrusted()
	guard let raw = str(params, "key") else { throw HelperError("key requires key") }
	let resolved = try resolveKey(raw)
	var modifiers = (params["modifiers"] as? [String]) ?? []
	if resolved.shift { modifiers.append("shift") }
	let repeatCount = max(1, min(100, Int(num(params, "repeat") ?? 1)))
	let holdMs = num(params, "holdMs")
	withModifiers(modifiers) { flags in
		for index in 0..<repeatCount {
			let down = CGEvent(keyboardEventSource: eventSource, virtualKey: resolved.code, keyDown: true)
			let up = CGEvent(keyboardEventSource: eventSource, virtualKey: resolved.code, keyDown: false)
			post(down, flags: flags)
			sleepMs(holdMs ?? 12)
			post(up, flags: flags)
			if index < repeatCount - 1 { sleepMs(30) }
		}
	}
}

// MARK: - Dispatch

func handle(_ request: [String: Any]) {
	let id: Any = request["id"] ?? NSNull()
	guard let op = request["op"] as? String else {
		fail(id: id, "Missing op")
		return
	}
	let explicitDisplay = num(request, "displayId").map { Int($0) }
	do {
		switch op {
		case "ping":
			respond(id: id, ["pong": true, "trusted": AXIsProcessTrusted(), "pid": Int(ProcessInfo.processInfo.processIdentifier)])
		case "display":
			respond(id: id, ["display": targetDisplay(explicit: explicitDisplay).json, "trusted": AXIsProcessTrusted()])
		case "capture":
			respond(id: id, try capture(params: request, display: targetDisplay(explicit: explicitDisplay)))
		case "ax":
			respond(id: id, accessibilitySnapshot(params: request, display: targetDisplay(explicit: explicitDisplay)))
		case "observe":
			let display = targetDisplay(explicit: explicitDisplay)
			var body = try capture(params: request, display: display)
			body["accessibility"] = accessibilitySnapshot(params: request, display: display)
			respond(id: id, body)
		case "settle":
			respond(id: id, settle(params: request, display: targetDisplay(explicit: explicitDisplay)))
		case "click":
			try click(params: request, display: targetDisplay(explicit: explicitDisplay))
			respond(id: id, [:])
		case "move":
			try requireTrusted()
			guard let x = num(request, "x"), let y = num(request, "y") else { throw HelperError("move requires x and y") }
			moveMouse(to: targetDisplay(explicit: explicitDisplay).toGlobal(x, y))
			respond(id: id, [:])
		case "drag":
			try drag(params: request, display: targetDisplay(explicit: explicitDisplay))
			respond(id: id, [:])
		case "scroll":
			try scroll(params: request, display: targetDisplay(explicit: explicitDisplay))
			respond(id: id, [:])
		case "type":
			try typeText(params: request)
			respond(id: id, [:])
		case "key":
			try pressKey(params: request)
			respond(id: id, [:])
		case "openApp":
			guard let name = str(request, "appName") else { throw HelperError("openApp requires appName") }
			let process = Process()
			process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
			process.arguments = ["-a", name]
			try process.run()
			process.waitUntilExit()
			if process.terminationStatus != 0 { throw HelperError("Could not open application \"\(name)\"") }
			respond(id: id, [:])
		default:
			fail(id: id, "Unknown op: \(op)")
		}
	} catch let error as HelperError {
		fail(id: id, error.message)
	} catch {
		fail(id: id, "\(error)")
	}
}

setvbuf(Foundation.stdout, nil, _IOLBF, 0)
while let line = readLine(strippingNewline: true) {
	guard !line.isEmpty, let data = line.data(using: .utf8),
		let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
	else { continue }
	handle(request)
}
