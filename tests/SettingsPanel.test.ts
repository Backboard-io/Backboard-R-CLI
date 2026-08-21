import { describe, expect, it } from "bun:test";
import {
	type SettingsState,
	settingsRows,
} from "../src/ui/components/SettingsPanel.tsx";

const BASE: SettingsState = {
	memory: "auto",
	expert: { enabled: false, model: null },
	verbose: false,
	notify: false,
	lsp: false,
	lspPending: false,
	browser: false,
	computerUse: false,
	discover: false,
};

describe("settingsRows", () => {
	it("lists the openers first, then the toggle rows", () => {
		const rows = settingsRows(BASE);
		expect(rows.map((row) => row.id)).toEqual([
			"memory",
			"expert",
			"verbose",
			"notify",
			"lsp",
			"browser",
			"computerUse",
			"discover",
		]);
		expect(rows.find((row) => row.id === "memory")).toMatchObject({
			kind: "open",
			label: "Memory",
			value: "Auto",
		});
		expect(rows.find((row) => row.id === "expert")).toMatchObject({
			kind: "open",
			label: "Expert",
			value: "Off",
		});
	});

	it("shows the execution model on the expert row once it is on", () => {
		const value = (expert: SettingsState["expert"]): string | undefined => {
			const row = settingsRows({ ...BASE, expert }).find(
				(entry) => entry.id === "expert",
			);
			return row?.kind === "open" ? row.value : undefined;
		};
		expect(value({ enabled: true, model: "moonshot/kimi-k3" })).toBe(
			"moonshot/kimi-k3",
		);
		// A remembered pick with the switch off still reads as off.
		expect(value({ enabled: false, model: "moonshot/kimi-k3" })).toBe("Off");
		expect(value({ enabled: true, model: null })).toBe("Off");
	});

	it("reports on/off state for the toggle rows", () => {
		const rows = settingsRows({
			...BASE,
			verbose: true,
			notify: false,
			lsp: true,
			browser: true,
			computerUse: false,
			discover: true,
		});
		const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
		expect(byId.verbose).toMatchObject({
			kind: "toggle",
			label: "Verbose",
			enabled: true,
		});
		expect(byId.notify).toMatchObject({ kind: "toggle", enabled: false });
		expect(byId.lsp).toMatchObject({
			kind: "toggle",
			enabled: true,
			pending: false,
		});
		expect(byId.browser).toMatchObject({ kind: "toggle", enabled: true });
		expect(byId.computerUse).toMatchObject({
			kind: "toggle",
			label: "Computer use",
			enabled: false,
		});
		expect(byId.discover).toMatchObject({
			kind: "toggle",
			label: "Discovery",
			enabled: true,
		});
	});

	it("includes a short description for every row", () => {
		const rows = settingsRows(BASE);
		for (const row of rows) {
			expect(row.description.length).toBeGreaterThan(0);
		}
		const descOf = (id: string) =>
			rows.find((row) => row.id === id)?.description;
		expect(descOf("verbose")).toBe("Detailed tool-call output");
		expect(descOf("discover")).toBe("Skill & MCP discovery tools");
	});

	it("marks the LSP row pending while its toggle is in flight", () => {
		const rows = settingsRows({ ...BASE, lspPending: true });
		expect(rows.find((row) => row.id === "lsp")).toMatchObject({
			kind: "toggle",
			pending: true,
		});
	});

	it("formats each memory mode as a readable label", () => {
		const value = (state: SettingsState): string | undefined => {
			const row = settingsRows(state).find((entry) => entry.id === "memory");
			return row?.kind === "open" ? row.value : undefined;
		};
		expect(value({ ...BASE, memory: "off" })).toBe("Off");
		expect(value({ ...BASE, memory: "on" })).toBe("On");
		expect(value({ ...BASE, memory: "auto" })).toBe("Auto");
		expect(value({ ...BASE, memory: "readonly" })).toBe("Readonly");
	});
});
