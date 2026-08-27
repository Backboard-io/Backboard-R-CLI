import { describe, expect, it } from "bun:test";
import { initialState } from "../src/state/AppState.ts";
import { reduce } from "../src/state/Store.ts";

describe("permission mode in app state", () => {
	it("defaults to auto", () => {
		expect(initialState("model-x").permissionMode).toBe("auto");
	});

	it("accepts an initial mode", () => {
		expect(initialState("model-x", "bypass").permissionMode).toBe("bypass");
	});

	it("reduces permission:mode events", () => {
		const state = initialState("model-x");
		const next = reduce(state, {
			type: "permission:mode",
			mode: "acceptEdits",
		});
		expect(next.permissionMode).toBe("acceptEdits");
	});
});
