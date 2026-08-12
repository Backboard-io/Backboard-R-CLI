import { describe, expect, it } from "bun:test";
import { shellPromptLayout } from "../src/ui/components/ShellPrompt.tsx";
import { compactPathLabel } from "../src/ui/utils/pathLabels.ts";

const LONG_USER = "muhammadbalawalsafdar";
const LONG_PATH = "~/Documents/backboard/Espri-API/r-cli";
const VERSION = "v0.2.1";

describe("shellPromptLayout", () => {
	it("keeps the full prompt when the terminal is wide enough", () => {
		expect(
			shellPromptLayout({
				columns: 120,
				user: LONG_USER,
				path: LONG_PATH,
				version: VERSION,
			}),
		).toEqual({
			user: LONG_USER,
			path: LONG_PATH,
			version: VERSION,
		});
	});

	it("keeps the full prompt while it still fits", () => {
		expect(
			shellPromptLayout({
				columns: 82,
				user: LONG_USER,
				path: LONG_PATH,
				version: VERSION,
			}),
		).toEqual({
			user: LONG_USER,
			path: LONG_PATH,
			version: VERSION,
		});
	});

	it("shortens the path before dropping prompt segments", () => {
		expect(
			shellPromptLayout({
				columns: 70,
				user: LONG_USER,
				path: LONG_PATH,
				version: VERSION,
			}),
		).toEqual({
			user: LONG_USER,
			path: "~/.../Espri-API/r-cli",
			version: VERSION,
		});
	});

	it("drops the username before dropping the version on narrow terminals", () => {
		expect(
			shellPromptLayout({
				columns: 40,
				user: LONG_USER,
				path: LONG_PATH,
				version: VERSION,
			}),
		).toEqual({
			path: "~/.../Espri-API/r-cli",
			version: VERSION,
		});
	});

	it("keeps only a compact path when there is not enough room for version", () => {
		expect(
			shellPromptLayout({
				columns: 18,
				user: LONG_USER,
				path: LONG_PATH,
				version: VERSION,
			}),
		).toEqual({
			path: "~/.../r-cli",
		});
	});
});

describe("compactPathLabel", () => {
	it("keeps the repository tail for home-relative paths", () => {
		expect(compactPathLabel(LONG_PATH, 18)).toBe("~/.../r-cli");
	});

	it("clips from the start when even the final path part is too long", () => {
		expect(compactPathLabel("~/Documents/super-long-repository-name", 12)).toBe(
			"...tory-name",
		);
	});
});
