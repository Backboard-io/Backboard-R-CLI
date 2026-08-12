import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createTheme } from "../src/ui/theme/theme.ts";

const UI_ROOT = join(import.meta.dir, "../src/ui");
const DYNAMIC_THEME_FIELDS = [
	"inputSurfaceBackground",
	"highlightBackground",
	"diffAddedBackground",
	"diffRemovedBackground",
] as const;

describe("UI theme usage", () => {
	it("keeps runtime surface colors behind ThemeProvider", async () => {
		const offenders: string[] = [];
		for (const file of await uiSourceFiles(UI_ROOT)) {
			const path = relative(join(import.meta.dir, ".."), file);
			if (path === "src/ui/theme/theme.ts") continue;
			const source = await readFile(file, "utf8");
			for (const field of DYNAMIC_THEME_FIELDS) {
				// \b keeps `uiTheme.<field>` (the ThemeProvider path) legal while
				// catching the module singleton, even via names like `myTheme`.
				if (new RegExp(`\\btheme\\.${field}\\b`).test(source)) {
					offenders.push(`${path}: theme.${field}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it("falls secondary text back to terminal foreground on low-contrast backgrounds and surfaces", () => {
		expect(createTheme("#05070b").subtle).toBe("gray");
		expect(createTheme("#05070b").readableSecondaryText).toBe("gray");
		expect(createTheme("#171717").subtle).toBeUndefined();
		expect(createTheme("#777777").subtle).toBeUndefined();
		expect(createTheme("#ffffff").subtle).toBeUndefined();
	});
});

async function uiSourceFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(root, entry.name);
			if (entry.isDirectory()) return uiSourceFiles(path);
			if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) return [];
			return [path];
		}),
	);
	return files.flat();
}
