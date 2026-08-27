import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { imageSize } from "../../src/core/platform/png.ts";
import type {
	AccessibilityElement,
	AccessibilitySnapshot,
	Platform,
	PlatformAction,
	ScreenBounds,
	ScreenshotCapture,
	ScreenshotOptions,
	SettleResult,
} from "../../src/core/platform/types.ts";

/**
 * A saved observation: one screenshot plus its element list, and the region
 * a correct click must land in. Captured from a real platform with
 * `capture-fixture.ts`; replayed offline through {@link FixturePlatform}.
 */
export interface GroundingFixture {
	name: string;
	instruction: string;
	os: "darwin" | "win32" | "linux";
	/** Relative to the fixture file. */
	image: string;
	mediaType: "image/png" | "image/jpeg";
	screenSize: { width: number; height: number };
	appName?: string;
	windowTitle?: string;
	elements: AccessibilityElement[];
	/** Acceptable click area, in screenSize space. */
	expected: ScreenBounds;
	/** The element the target corresponds to, when it is in the list. */
	expectedElementId?: string;
	/** Fixtures whose target is absent from `elements` test coordinate grounding. */
	hideTarget?: boolean;
}

export async function loadFixture(path: string): Promise<{
	fixture: GroundingFixture;
	imagePath: string;
}> {
	const fixture = JSON.parse(await readFile(path, "utf8")) as GroundingFixture;
	return { fixture, imagePath: resolve(dirname(path), fixture.image) };
}

/**
 * Serves a fixture as if it were a live screen. Every state-changing action
 * is recorded; nothing changes, so the replay is deterministic and free.
 */
export class FixturePlatform implements Platform {
	readonly os: "darwin" | "win32" | "linux";
	readonly actions: PlatformAction[] = [];
	private readonly elements: AccessibilityElement[];

	constructor(
		private readonly fixture: GroundingFixture,
		private readonly imagePath: string,
	) {
		this.os = fixture.os;
		this.elements = fixture.hideTarget
			? fixture.elements.filter((e) => e.id !== fixture.expectedElementId)
			: fixture.elements;
	}

	async screenshot(options: ScreenshotOptions): Promise<ScreenshotCapture> {
		const bytes = await readFile(this.imagePath);
		await writeFile(options.path, bytes);
		const size = imageSize(bytes, "fixture");
		return {
			path: options.path,
			bytes,
			mediaType: this.fixture.mediaType,
			imageSize: size,
			screenSize: this.fixture.screenSize,
			scale: size.width / this.fixture.screenSize.width,
			...(options.region ? { region: options.region } : {}),
		};
	}

	async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
		return {
			...(this.fixture.appName ? { appName: this.fixture.appName } : {}),
			...(this.fixture.windowTitle
				? { windowTitle: this.fixture.windowTitle }
				: {}),
			elements: this.elements,
			trusted: true,
		};
	}

	async settle(): Promise<SettleResult> {
		return { settled: true, elapsedMs: 0 };
	}

	async execute(action: PlatformAction): Promise<void> {
		this.actions.push(action);
	}

	async dispose(): Promise<void> {}

	/** The first click the agent made, if any. */
	get firstClick(): { x: number; y: number } | null {
		const click = this.actions.find((a) => a.kind === "click");
		return click && click.kind === "click" ? click.point : null;
	}
}

export function pointInBounds(
	point: { x: number; y: number },
	bounds: ScreenBounds,
): boolean {
	return (
		point.x >= bounds.x &&
		point.x <= bounds.x + bounds.width &&
		point.y >= bounds.y &&
		point.y <= bounds.y + bounds.height
	);
}
