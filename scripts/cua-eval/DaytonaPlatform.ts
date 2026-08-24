import { writeFile } from "node:fs/promises";
import { Daytona, type Sandbox } from "@daytona/sdk";
import { imageSize } from "../../src/core/platform/png.ts";
import type {
	AccessibilityElement,
	AccessibilitySnapshot,
	Platform,
	PlatformAction,
	PlatformKey,
	ScreenBounds,
	ScreenshotCapture,
	ScreenshotOptions,
	SettleOptions,
	SettleResult,
} from "../../src/core/platform/types.ts";

export interface DaytonaPlatformOptions {
	/** Snapshot name to create the sandbox from; falls back to the base image. */
	snapshot?: string;
	image?: string;
	/** e.g. "1280x800x24"; fixed for the sandbox's lifetime. */
	resolution?: string;
	cpu?: number;
	memory?: number;
	labels?: Record<string, string>;
	log?: (line: string) => void;
}

export const DEFAULT_DAYTONA_IMAGE = "daytonaio/sandbox:0.6.0";

/** Linux command lines for the app names the agent is likely to use. */
const APP_COMMANDS: Record<string, string> = {
	"text editor": "mousepad",
	texteditor: "mousepad",
	textedit: "mousepad",
	notepad: "mousepad",
	gedit: "gedit",
	mousepad: "mousepad",
	terminal: "xfce4-terminal",
	"xfce terminal": "xfce4-terminal",
	firefox: "firefox",
	browser: "firefox",
	chrome: "chromium",
	chromium: "chromium",
	calculator: "galculator",
	files: "thunar",
	"file manager": "thunar",
	thunar: "thunar",
	settings: "xfce4-settings-manager",
	libreoffice: "libreoffice",
	writer: "libreoffice --writer",
	calc: "libreoffice --calc",
};

/** Canonical key names → xdotool names the Daytona keyboard API understands. */
const XDOTOOL_KEYS: Record<string, string> = {
	ENTER: "Return",
	TAB: "Tab",
	SPACE: "space",
	ESC: "Escape",
	BACKSPACE: "BackSpace",
	DELETE: "Delete",
	UP: "Up",
	DOWN: "Down",
	LEFT: "Left",
	RIGHT: "Right",
	HOME: "Home",
	END: "End",
	PAGEUP: "Page_Up",
	PAGEDOWN: "Page_Down",
	INSERT: "Insert",
	CAPSLOCK: "Caps_Lock",
	"+": "plus",
	"-": "minus",
	"=": "equal",
	"/": "slash",
	"\\": "backslash",
	",": "comma",
	".": "period",
	";": "semicolon",
	"'": "apostrophe",
	"`": "grave",
	"[": "bracketleft",
	"]": "bracketright",
};

const INTERACTIVE_ROLES = new Set([
	"push button",
	"button",
	"toggle button",
	"check box",
	"radio button",
	"text",
	"entry",
	"password text",
	"combo box",
	"menu item",
	"menu",
	"list item",
	"table cell",
	"link",
	"page tab",
	"slider",
	"spin button",
	"tree item",
	"label",
	"heading",
	"document text",
	"document web",
	"frame",
	"dialog",
	"alert",
	"icon",
	"image",
	"scroll bar",
]);

interface AtspiNode {
	id?: string;
	role?: string;
	name?: string;
	description?: string;
	states?: string[];
	bounds?: { x?: number; y?: number; width?: number; height?: number };
	children?: AtspiNode[];
}

/**
 * Runs the same agent code against a Daytona Linux desktop (XFCE over Xvfb).
 * The sandbox renders at a fixed resolution, so point space == pixel space;
 * screenshots are downscaled client-side like every other platform.
 */
export class DaytonaPlatform implements Platform {
	readonly os = "linux" as const;
	private screenSize: { width: number; height: number } | null = null;
	private browserCommand: string | null = null;
	private sessionEnvCache: Record<string, string> | null = null;

	private constructor(
		readonly sandbox: Sandbox,
		private readonly log: (line: string) => void,
	) {}

	static async create(
		options: DaytonaPlatformOptions = {},
	): Promise<DaytonaPlatform> {
		const log = options.log ?? (() => {});
		const daytona = new Daytona();
		const resolution = options.resolution ?? "1280x800x24";
		const started = performance.now();
		const sandbox = options.snapshot
			? await daytona.create(
					{
						snapshot: options.snapshot,
						envVars: { VNC_RESOLUTION: resolution },
						labels: options.labels,
						ephemeral: true,
					},
					{ timeout: 180 },
				)
			: await daytona.create(
					{
						image: options.image ?? DEFAULT_DAYTONA_IMAGE,
						envVars: { VNC_RESOLUTION: resolution },
						labels: options.labels,
						ephemeral: true,
						resources: {
							cpu: options.cpu ?? 2,
							memory: options.memory ?? 4,
						},
					},
					{ timeout: 240 },
				);
		log(
			`sandbox ${sandbox.id} created in ${Math.round(performance.now() - started)}ms`,
		);
		const platform = new DaytonaPlatform(sandbox, log);
		await sandbox.computerUse.start();
		await platform.waitForDisplay();
		return platform;
	}

	/** Maps "browser"/"firefox" app names onto the browser that is installed. */
	setBrowserCommand(command: string): void {
		this.browserCommand = command;
	}

	/**
	 * Runs a command with the desktop session's environment (DISPLAY and the
	 * session D-Bus address). Without the bus, GUI apps and xfconf-query talk
	 * to a throwaway daemon and their changes never reach the real desktop.
	 */
	async exec(
		command: string,
		timeoutSeconds = 60,
		env: Record<string, string> = {},
	): Promise<{ exitCode: number; output: string }> {
		// The SDK's env parameter does not reliably reach the child, so export
		// the session variables in the command itself.
		const merged = { ...(await this.sessionEnv()), ...env };
		const prefix = Object.entries(merged)
			.map(
				([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}';`,
			)
			.join(" ");
		const result = await this.sandbox.process.executeCommand(
			`${prefix} ${command}`,
			undefined,
			undefined,
			timeoutSeconds,
		);
		return { exitCode: result.exitCode, output: result.result };
	}

	/** Environment of the running desktop session (display, D-Bus, XDG dirs). */
	async sessionEnv(): Promise<Record<string, string>> {
		if (this.sessionEnvCache) return this.sessionEnvCache;
		const result = await this.sandbox.process.executeCommand(
			"pid=$(pgrep -o xfce4-session || pgrep -o xfwm4 || pgrep -o xfdesktop); [ -n \"$pid\" ] && tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | grep -E '^(DISPLAY|DBUS_SESSION_BUS_ADDRESS|XAUTHORITY|XDG_RUNTIME_DIR|XDG_CURRENT_DESKTOP|XDG_CONFIG_HOME|XDG_DATA_DIRS|XDG_CONFIG_DIRS|LANG)='",
			undefined,
			undefined,
			20,
		);
		const env: Record<string, string> = {};
		for (const line of result.result.split("\n")) {
			const index = line.indexOf("=");
			if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
		}
		if (!env.DISPLAY) env.DISPLAY = ":0";
		// Make GTK/Chromium apps register with AT-SPI so they show up in the tree.
		env.GTK_MODULES = "gail:atk-bridge";
		env.ACCESSIBILITY_ENABLED = "1";
		env.NO_AT_BRIDGE = "0";
		env.QT_ACCESSIBILITY = "1";
		this.sessionEnvCache = env;
		this.log(
			`session env: DISPLAY=${env.DISPLAY}${env.DBUS_SESSION_BUS_ADDRESS ? " dbus ok" : " (no session bus)"}`,
		);
		return env;
	}

	async previewUrl(): Promise<string> {
		const link = await this.sandbox.getPreviewLink(6080);
		return link.url;
	}

	async screenshot(
		options: ScreenshotOptions,
		_signal: AbortSignal,
	): Promise<ScreenshotCapture> {
		const screen = await this.displaySize();
		const format = options.format;
		const sourceWidth = options.region?.width ?? screen.width;
		const scale = Math.min(1, options.maxWidth / sourceWidth);
		const shot = options.region
			? await this.sandbox.computerUse.screenshot.takeCompressedRegion(
					roundRegion(options.region),
					{
						format,
						quality: Math.round((options.quality ?? 0.85) * 100),
						scale,
						showCursor: true,
					},
				)
			: await this.sandbox.computerUse.screenshot.takeCompressed({
					format,
					quality: Math.round((options.quality ?? 0.85) * 100),
					scale,
					showCursor: true,
				});
		if (!shot.screenshot)
			throw new Error("Daytona returned an empty screenshot");
		const bytes = Buffer.from(shot.screenshot, "base64");
		await writeFile(options.path, bytes);
		const size = imageSize(bytes, "daytona screenshot");
		return {
			path: options.path,
			bytes,
			mediaType: format === "jpeg" ? "image/jpeg" : "image/png",
			imageSize: size,
			screenSize: screen,
			scale: size.width / sourceWidth,
			...(options.region ? { region: roundRegion(options.region) } : {}),
		};
	}

	async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
		const screen = await this.displaySize();
		let tree: { root?: AtspiNode } | undefined;
		try {
			tree = await this.sandbox.computerUse.accessibility.getTree({
				scope: "all",
				maxDepth: 16,
			});
		} catch (err) {
			this.log(
				`accessibility tree unavailable: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { elements: [], trusted: false };
		}
		const elements: AccessibilityElement[] = [];
		let focusedElementId: string | undefined;
		const root = pickActiveFrame(tree?.root) ?? tree?.root;
		return {
			...(root?.name ? { windowTitle: root.name } : {}),
			...(focusedElementId ? { focusedElementId } : {}),
			elements,
			trusted: true,
		};
	}

	async settle(options: SettleOptions): Promise<SettleResult> {
		const started = performance.now();
		const interval = options.intervalMs ?? 150;
		await sleep(options.initialDelayMs ?? 80);
		let previous = await this.thumbnail();
		while (performance.now() - started < options.timeoutMs) {
			await sleep(interval);
			const current = await this.thumbnail();
			if (previous && current && previous.equals(current)) {
				return {
					settled: true,
					elapsedMs: Math.round(performance.now() - started),
				};
			}
			previous = current;
		}
		return {
			settled: false,
			elapsedMs: Math.round(performance.now() - started),
		};
	}

	async execute(action: PlatformAction): Promise<void> {
		const cu = this.sandbox.computerUse;
		switch (action.kind) {
			case "openApp": {
				const lower = action.appName.toLowerCase();
				const command =
					this.browserCommand &&
					/^(browser|firefox|chrome|chromium|web)$/.test(lower)
						? this.browserCommand
						: (APP_COMMANDS[lower] ?? action.appName);
				const result = await this.exec(
					`(command -v ${command.split(" ")[0]} >/dev/null 2>&1 && (nohup ${command} >/dev/null 2>&1 &) && echo ok) || echo missing`,
					20,
				);
				if (!result.output.includes("ok")) {
					throw new Error(
						`Application "${action.appName}" (${command}) is not installed in the sandbox`,
					);
				}
				return;
			}
			case "type":
				await cu.keyboard.type(action.text, 8);
				return;
			case "key": {
				const chord = toXdotoolChord(action.key);
				for (let i = 0; i < (action.repeat ?? 1); i++) {
					await cu.keyboard.hotkey(chord);
				}
				return;
			}
			case "holdKey":
				await cu.keyboard.press(
					toXdotoolKey(action.key.key),
					action.key.modifiers.map(toXdotoolModifier),
				);
				return;
			case "click": {
				const x = Math.round(action.point.x);
				const y = Math.round(action.point.y);
				if (action.modifiers.length > 0) {
					// No modifier-click primitive: hold via hotkey is not possible, so
					// approximate with the plain click (documented limitation).
					this.log(
						`modifier click ${action.modifiers.join("+")} approximated as plain click`,
					);
				}
				if (action.count >= 3) {
					await cu.mouse.click(x, y, action.button, true);
					await cu.mouse.click(x, y, action.button, false);
					return;
				}
				await cu.mouse.click(x, y, action.button, action.count === 2);
				return;
			}
			case "move":
				await cu.mouse.move(
					Math.round(action.point.x),
					Math.round(action.point.y),
				);
				return;
			case "drag":
				await cu.mouse.drag(
					Math.round(action.from.x),
					Math.round(action.from.y),
					Math.round(action.to.x),
					Math.round(action.to.y),
					action.button,
				);
				return;
			case "scroll": {
				const screen = await this.displaySize();
				const x = Math.round(action.point?.x ?? screen.width / 2);
				const y = Math.round(action.point?.y ?? screen.height / 2);
				if (action.dy !== 0) {
					await cu.mouse.scroll(
						x,
						y,
						action.dy > 0 ? "down" : "up",
						Math.abs(action.dy),
					);
				}
				if (action.dx !== 0) {
					// Horizontal scrolling maps to shift+wheel in most GTK apps.
					await cu.mouse.move(x, y);
					await cu.keyboard.press(action.dx > 0 ? "Right" : "Left", ["shift"]);
				}
				return;
			}
		}
	}

	async dispose(): Promise<void> {
		try {
			await this.sandbox.delete(60);
			this.log(`sandbox ${this.sandbox.id} deleted`);
		} catch (err) {
			this.log(
				`sandbox delete failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async displaySize(): Promise<{ width: number; height: number }> {
		if (this.screenSize) return this.screenSize;
		const info = await this.sandbox.computerUse.display.getInfo();
		const primary =
			info.displays?.find((d) => d.isActive) ?? info.displays?.[0];
		if (!primary?.width || !primary.height) {
			throw new Error("Daytona display info is unavailable");
		}
		this.screenSize = { width: primary.width, height: primary.height };
		return this.screenSize;
	}

	private async waitForDisplay(): Promise<void> {
		const deadline = Date.now() + 60_000;
		let lastError = "";
		while (Date.now() < deadline) {
			try {
				await this.displaySize();
				await this.sandbox.computerUse.screenshot.takeCompressed({
					format: "png",
					scale: 0.1,
				});
				return;
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				await sleep(1000);
			}
		}
		throw new Error(`Daytona desktop did not come up: ${lastError}`);
	}

	private async thumbnail(): Promise<Buffer | null> {
		try {
			const shot = await this.sandbox.computerUse.screenshot.takeCompressed({
				format: "png",
				scale: 0.08,
				showCursor: false,
			});
			return shot.screenshot ? Buffer.from(shot.screenshot, "base64") : null;
		} catch {
			return null;
		}
	}
}

const SHELL_APPS = new Set([
	"xfce4-panel",
	"xfdesktop",
	"xfwm4",
	"xfce4-session",
	"xfsettingsd",
]);

/**
 * The desktop root lists every application; the model wants the window it is
 * working in. Prefer an `active` frame, then the most recently registered
 * visible frame that is not part of the desktop shell.
 */
function pickActiveFrame(root: AtspiNode | undefined): AtspiNode | null {
	if (!root) return null;
	const frames: AtspiNode[] = [];
	for (const app of root.children ?? []) {
		if (SHELL_APPS.has(app.name ?? "")) continue;
		for (const frame of app.children ?? []) {
			const states = frame.states ?? [];
			const b = frame.bounds;
			if (!b || (b.width ?? 0) < 50 || (b.height ?? 0) < 50) continue;
			if (states.includes("visible") || states.includes("showing"))
				frames.push(frame);
		}
	}
	if (frames.length === 0) return null;
	return (
		frames.find((f) => (f.states ?? []).includes("active")) ??
		frames[frames.length - 1] ??
		null
	);
}

function roundRegion(region: ScreenBounds): ScreenBounds {
	return {
		x: Math.round(region.x),
		y: Math.round(region.y),
		width: Math.round(region.width),
		height: Math.round(region.height),
	};
}

function toXdotoolModifier(modifier: PlatformKey["modifiers"][number]): string {
	switch (modifier) {
		case "meta":
			return "super";
		case "control":
			return "ctrl";
		default:
			return modifier;
	}
}

function toXdotoolKey(key: string): string {
	if (XDOTOOL_KEYS[key]) return XDOTOOL_KEYS[key] as string;
	if (key.length === 1) return key.toLowerCase();
	if (/^F\d{1,2}$/.test(key)) return key;
	return key.toLowerCase();
}

export function toXdotoolChord(key: PlatformKey): string {
	return [...key.modifiers.map(toXdotoolModifier), toXdotoolKey(key.key)].join(
		"+",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
