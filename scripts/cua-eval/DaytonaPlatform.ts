import { randomUUID } from "node:crypto";
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
		try {
			await sandbox.computerUse.start();
			await platform.waitForDisplay();
			return platform;
		} catch (error) {
			await sandbox.delete(60).catch(() => {});
			throw error;
		}
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
		cwd?: string,
		signal?: AbortSignal,
	): Promise<{
		exitCode: number;
		output: string;
		stdout?: string;
		stderr?: string;
		timedOut?: boolean;
	}> {
		if (signal?.aborted) throw new Error("aborted");
		// The SDK's env parameter does not reliably reach the child, so export
		// the session variables in the command itself.
		const merged = { ...(await this.sessionEnv()), ...env };
		const prefix = Object.entries(merged)
			.map(
				([key, value]) => `export ${key}='${value.replaceAll("'", "'\\''")}';`,
			)
			.join(" ");
		if (signal) {
			return this.execInCancellableSession(
				`${prefix} ${command}`,
				timeoutSeconds,
				cwd,
				signal,
			);
		}
		const result = await this.sandbox.process.executeCommand(
			`${prefix} ${command}`,
			cwd,
			undefined,
			timeoutSeconds,
		);
		return {
			exitCode: result.exitCode,
			output: result.result,
			stdout: result.result,
			stderr: "",
		};
	}

	private async execInCancellableSession(
		command: string,
		timeoutSeconds: number,
		cwd: string | undefined,
		signal: AbortSignal,
	): Promise<{
		exitCode: number;
		output: string;
		stdout: string;
		stderr: string;
		timedOut?: boolean;
	}> {
		if (signal.aborted) throw new Error("aborted");
		const sessionId = `cua-eval-${randomUUID()}`;
		const process = this.sandbox.process;
		await process.createSession(sessionId);
		let rejectAbort: ((error: Error) => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () => {
			rejectAbort?.(new Error("aborted"));
			void process.deleteSession(sessionId).catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			signal.removeEventListener("abort", onAbort);
			await process.deleteSession(sessionId).catch(() => {});
			throw new Error("aborted");
		}
		const fullCommand = cwd
			? `cd -- ${shellQuote(cwd)} && ${command}`
			: command;
		try {
			const result = await Promise.race([
				process.executeSessionCommand(
					sessionId,
					{ command: fullCommand },
					timeoutSeconds,
				),
				aborted,
			]);
			return {
				exitCode: result.exitCode ?? 1,
				output: combinedOutput(result.stdout, result.stderr, result.output),
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		} catch (error) {
			if (signal.aborted) throw new Error("aborted");
			if (isTimeoutError(error)) {
				const stderr = `Command timed out after ${timeoutSeconds}s`;
				return {
					exitCode: 124,
					output: stderr,
					stdout: "",
					stderr,
					timedOut: true,
				};
			}
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
			await process.deleteSession(sessionId).catch(() => {});
		}
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
		signal: AbortSignal,
	): Promise<ScreenshotCapture> {
		const screen = await this.displaySize(signal);
		const format = options.format;
		const region = options.region ? roundRegion(options.region) : null;
		const sourceWidth = region?.width ?? screen.width;
		const scale = Math.min(1, options.maxWidth / sourceWidth);
		const shot = await withSignal(
			region
				? () =>
						this.sandbox.computerUse.screenshot.takeCompressedRegion(region, {
							format,
							quality: Math.round((options.quality ?? 0.85) * 100),
							scale,
							showCursor: true,
						})
				: () =>
						this.sandbox.computerUse.screenshot.takeCompressed({
							format,
							quality: Math.round((options.quality ?? 0.85) * 100),
							scale,
							showCursor: true,
						}),
			signal,
		);
		if (!shot.screenshot)
			throw new Error("Daytona returned an empty screenshot");
		const bytes = Buffer.from(shot.screenshot, "base64");
		await writeFile(options.path, bytes, { signal });
		const size = imageSize(bytes, "daytona screenshot");
		return {
			path: options.path,
			bytes,
			mediaType: format === "jpeg" ? "image/jpeg" : "image/png",
			imageSize: size,
			screenSize: screen,
			scale: size.width / sourceWidth,
			...(region ? { region } : {}),
		};
	}

	async accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		const screen = await this.displaySize(signal);
		let tree: { root?: AtspiNode } | undefined;
		try {
			tree = await withSignal(
				() =>
					this.sandbox.computerUse.accessibility.getTree({
						scope: "all",
						maxDepth: 16,
					}),
				signal,
			);
		} catch (err) {
			if (signal.aborted) throw err;
			this.log(
				`accessibility tree unavailable: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { elements: [], trusted: false };
		}
		const elements: AccessibilityElement[] = [];
		let focusedElementId: string | undefined;
		const root = pickActiveFrame(tree?.root) ?? tree?.root;
		if (root) {
			const stack: AtspiNode[] = [root];
			while (stack.length > 0 && elements.length < 80) {
				const node = stack.pop();
				if (!node) continue;
				for (
					let index = (node.children?.length ?? 0) - 1;
					index >= 0;
					index--
				) {
					const child = node.children?.[index];
					if (child) stack.push(child);
				}
				const role = node.role?.toLowerCase();
				const bounds = normalizeAtspiBounds(node.bounds, screen);
				const states = node.states ?? [];
				if (!role || !INTERACTIVE_ROLES.has(role) || !bounds) continue;
				const id = node.id || `el_${elements.length + 1}`;
				const element: AccessibilityElement = {
					id,
					role,
					bounds,
					...(node.name ? { name: node.name.slice(0, 120) } : {}),
					...(node.description
						? { value: node.description.slice(0, 120) }
						: {}),
					...(states.includes("disabled") ? { enabled: false } : {}),
					...(states.includes("focused") ? { focused: true } : {}),
				};
				if (element.focused) focusedElementId = id;
				elements.push(element);
			}
		}
		const windowBounds = root?.bounds
			? normalizeAtspiBounds(root.bounds, screen)
			: undefined;
		return {
			...(root?.name ? { windowTitle: root.name } : {}),
			...(windowBounds ? { windowBounds } : {}),
			...(focusedElementId ? { focusedElementId } : {}),
			elements,
			trusted: true,
		};
	}

	async settle(
		options: SettleOptions,
		signal: AbortSignal,
	): Promise<SettleResult> {
		const started = performance.now();
		const interval = options.intervalMs ?? 150;
		await sleep(options.initialDelayMs ?? 80, signal);
		let previous = await this.thumbnail(signal);
		while (performance.now() - started < options.timeoutMs) {
			await sleep(interval, signal);
			const current = await this.thumbnail(signal);
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

	async execute(action: PlatformAction, signal: AbortSignal): Promise<void> {
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
					{},
					undefined,
					signal,
				);
				if (!result.output.includes("ok")) {
					throw new Error(
						`Application "${action.appName}" (${command}) is not installed in the sandbox`,
					);
				}
				return;
			}
			case "type":
				await withSignal(() => cu.keyboard.type(action.text, 8), signal);
				return;
			case "key": {
				const chord = toXdotoolChord(action.key);
				for (let i = 0; i < (action.repeat ?? 1); i++) {
					await withSignal(() => cu.keyboard.hotkey(chord), signal);
				}
				return;
			}
			case "holdKey":
				{
					const keys = [
						...action.key.modifiers.map(toXdotoolModifier),
						toXdotoolKey(action.key.key),
					];
					const press = keys
						.map((key) => `xdotool keydown ${shellQuote(key)}`)
						.join("; ");
					const release = [...keys]
						.reverse()
						.map((key) => `xdotool keyup ${shellQuote(key)}`)
						.join("; ");
					await this.exec(
						`set -e; trap ${shellQuote(release)} EXIT; ${press}; sleep ${action.durationMs / 1000}`,
						Math.ceil(action.durationMs / 1000) + 10,
						{},
						undefined,
						signal,
					);
				}
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
					await withSignal(
						() => cu.mouse.click(x, y, action.button, true),
						signal,
					);
					await withSignal(
						() => cu.mouse.click(x, y, action.button, false),
						signal,
					);
					return;
				}
				await withSignal(
					() => cu.mouse.click(x, y, action.button, action.count === 2),
					signal,
				);
				return;
			}
			case "move":
				await withSignal(
					() =>
						cu.mouse.move(
							Math.round(action.point.x),
							Math.round(action.point.y),
						),
					signal,
				);
				return;
			case "drag":
				await withSignal(
					() =>
						cu.mouse.drag(
							Math.round(action.from.x),
							Math.round(action.from.y),
							Math.round(action.to.x),
							Math.round(action.to.y),
							action.button,
						),
					signal,
				);
				return;
			case "scroll": {
				const screen = await this.displaySize(signal);
				const x = Math.round(action.point?.x ?? screen.width / 2);
				const y = Math.round(action.point?.y ?? screen.height / 2);
				if (action.dy !== 0) {
					await withSignal(
						() =>
							cu.mouse.scroll(
								x,
								y,
								action.dy > 0 ? "down" : "up",
								Math.abs(action.dy),
							),
						signal,
					);
				}
				if (action.dx !== 0) {
					const button = action.dx > 0 ? 7 : 6;
					await this.exec(
						`xdotool mousemove ${x} ${y} click --repeat ${Math.abs(action.dx)} --delay 40 ${button}`,
						20,
						{},
						undefined,
						signal,
					);
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

	private async displaySize(
		signal?: AbortSignal,
	): Promise<{ width: number; height: number }> {
		if (this.screenSize) return this.screenSize;
		const info = await withSignal(
			() => this.sandbox.computerUse.display.getInfo(),
			signal,
		);
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

	private async thumbnail(signal?: AbortSignal): Promise<Buffer | null> {
		try {
			const shot = await withSignal(
				() =>
					this.sandbox.computerUse.screenshot.takeCompressed({
						format: "png",
						scale: 0.08,
						showCursor: false,
					}),
				signal,
			);
			return shot.screenshot ? Buffer.from(shot.screenshot, "base64") : null;
		} catch (err) {
			if (signal?.aborted) throw err;
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

function normalizeAtspiBounds(
	bounds: AtspiNode["bounds"],
	screen: { width: number; height: number },
): ScreenBounds | undefined {
	const x = bounds?.x;
	const y = bounds?.y;
	const width = bounds?.width;
	const height = bounds?.height;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		x >= screen.width ||
		y >= screen.height ||
		x + width <= 0 ||
		y + height <= 0
	) {
		return undefined;
	}
	const left = Math.max(0, x);
	const top = Math.max(0, y);
	const right = Math.min(screen.width, x + width);
	const bottom = Math.min(screen.height, y + height);
	return { x: left, y: top, width: right - left, height: bottom - top };
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function withSignal<T>(
	start: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return start();
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	const promise = start();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function combinedOutput(
	stdout: string | undefined,
	stderr: string | undefined,
	output: string | undefined,
): string {
	if (stdout || stderr) {
		return [stdout, stderr].filter(Boolean).join("\n");
	}
	return output ?? "";
}

function isTimeoutError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const record = error as { code?: unknown; message?: unknown };
	return (
		record.code === "ECONNABORTED" ||
		(typeof record.message === "string" && /timeout/i.test(record.message))
	);
}
