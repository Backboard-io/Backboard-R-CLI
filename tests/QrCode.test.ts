import { describe, expect, it } from "bun:test";
import { authLoadingLayout } from "../src/ui/AuthScreen.tsx";
import { renderQrCodeLines } from "../src/ui/utils/qrCode.ts";

const LOGIN_URL = "https://app.backboard.io/oauth/device?user_code=WDJB-MJHT";

describe("renderQrCodeLines", () => {
	it("renders a version-4 code for the https device login url", () => {
		const lines = renderQrCodeLines(LOGIN_URL);
		expect(lines).toHaveLength(17);
		for (const line of lines) {
			expect(line).toHaveLength(33);
		}
	});

	it("uses only half-block characters", () => {
		for (const line of renderQrCodeLines(LOGIN_URL)) {
			expect(line).toMatch(/^[ ▀▄█]+$/);
		}
	});

	it("draws finder squares in the corners", () => {
		const lines = renderQrCodeLines(LOGIN_URL);
		expect(lines[0]?.startsWith("█▀▀▀▀▀█")).toBe(true);
		expect(lines[0]?.endsWith("█▀▀▀▀▀█")).toBe(true);
		expect(lines.at(-1)?.startsWith("▀▀▀▀▀▀▀")).toBe(true);
	});

	it("is deterministic for the same input", () => {
		expect(renderQrCodeLines("hello")).toEqual(renderQrCodeLines("hello"));
	});

	it("returns no lines for empty input instead of throwing", () => {
		expect(renderQrCodeLines("")).toEqual([]);
	});
});

describe("authLoadingLayout", () => {
	// 33 cols x 17 rows for the https device login url
	const lines = renderQrCodeLines(LOGIN_URL);

	it("shows the full prompt and the QR on tall terminals", () => {
		expect(authLoadingLayout(lines, 80, 45)).toEqual({
			showPrompt: true,
			showQr: true,
		});
	});

	it("keeps the full layout down to its exact fit boundary", () => {
		expect(authLoadingLayout(lines, 80, 41)).toEqual({
			showPrompt: true,
			showQr: true,
		});
		expect(authLoadingLayout(lines, 80, 40)).toEqual({
			showPrompt: false,
			showQr: true,
		});
	});

	it("drops the prompt to fit the QR down to its compact boundary", () => {
		expect(authLoadingLayout(lines, 80, 25)).toEqual({
			showPrompt: false,
			showQr: true,
		});
	});

	it("falls back to the text url when even compact does not fit (80x24)", () => {
		expect(authLoadingLayout(lines, 80, 24)).toEqual({
			showPrompt: true,
			showQr: false,
		});
	});

	it("hides the QR instead of letting it wrap on narrow terminals", () => {
		expect(authLoadingLayout(lines, 35, 45)).toEqual({
			showPrompt: true,
			showQr: true,
		});
		expect(authLoadingLayout(lines, 34, 45)).toEqual({
			showPrompt: true,
			showQr: false,
		});
	});

	it("shows the normal screen when there is no QR to show", () => {
		expect(authLoadingLayout([], 80, 45)).toEqual({
			showPrompt: true,
			showQr: false,
		});
	});
});
