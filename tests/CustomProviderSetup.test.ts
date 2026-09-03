import { describe, expect, it } from "bun:test";
import { render } from "ink";
import React from "react";
import type { CustomProviderDefinition } from "../src/config/providers.ts";
import type { ProviderKeyController } from "../src/core/keys/ProviderKeyController.ts";
import { CustomProviderSetup } from "../src/ui/components/CustomProviderSetup.tsx";
import { makeInkTty } from "./inkHarness.ts";

const ESC = String.fromCharCode(27);
const KEY = {
	down: `${ESC}[B`,
	enter: String.fromCharCode(13),
};

const sleep = (ms = 25): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (predicate()) return;
		await sleep();
	}
}

function mount(existing?: CustomProviderDefinition) {
	const tty = makeInkTty(110, 32);
	let saved:
		| {
				definition: CustomProviderDefinition;
				key?: string;
				previousId?: string;
		  }
		| undefined;
	const controller = {
		saveCustomProvider: async (
			definition: CustomProviderDefinition,
			key?: string,
			previousId?: string,
		) => {
			saved = { definition, key, previousId };
		},
	} as unknown as ProviderKeyController;
	let completed: string | null = null;
	const instance = render(
		React.createElement(CustomProviderSetup, {
			controller,
			onDone: (provider: string) => {
				completed = provider;
			},
			onCancel: () => undefined,
			...(existing ? { existing } : {}),
		}),
		{
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	const send = async (...inputs: string[]): Promise<void> => {
		for (const input of inputs) {
			tty.feed(input);
			await sleep();
		}
	};
	return {
		send,
		saved: () => saved,
		completed: () => completed,
		written: tty.written,
		unmount: instance.unmount,
	};
}

describe("CustomProviderSetup", () => {
	it("creates a keyless OpenAI-compatible provider through the UI", async () => {
		const ui = mount();
		await sleep();
		await ui.send(
			"Local Provider",
			KEY.enter,
			KEY.enter,
			KEY.enter,
			"http://localhost:8000/v1",
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
		);
		await waitFor(() => ui.saved() !== undefined);

		expect(ui.saved()).toEqual({
			definition: {
				id: "local-provider",
				name: "Local Provider",
				protocol: "openai-chat",
				baseUrl: "http://localhost:8000/v1",
				auth: { type: "none" },
				discoverModels: true,
				headers: {},
				extraArgs: {},
				models: [],
			},
			key: undefined,
			previousId: undefined,
		});
		expect(ui.completed()).toBe("local-provider");
		ui.unmount();
	});

	it("never renders a pasted API key in terminal output", async () => {
		const ui = mount();
		await sleep();
		await ui.send(
			"Private",
			KEY.enter,
			KEY.enter,
			KEY.enter,
			"https://api.example.com/v1",
			KEY.enter,
			KEY.down,
			KEY.enter,
			"super-secret-provider-token",
		);
		await sleep();

		expect(ui.written()).not.toContain("super-secret-provider-token");
		ui.unmount();
	});

	it("never renders credential-bearing header values in terminal output", async () => {
		const ui = mount();
		await sleep();
		await ui.send(
			"Private",
			KEY.enter,
			KEY.enter,
			KEY.enter,
			"https://api.example.com/v1",
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			'{"X-Auth":"header-secret-token"}',
		);
		await sleep();

		expect(ui.written()).not.toContain("header-secret-token");
		ui.unmount();
	});

	it("preserves implicit API-key authentication when editing", async () => {
		const ui = mount({
			id: "legacy",
			name: "Legacy",
			protocol: "openai-chat",
			baseUrl: "https://models.example/v1",
		});
		await sleep();
		await ui.send(
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
			KEY.enter,
		);
		await waitFor(() => ui.saved() !== undefined);

		expect(ui.saved()?.definition.auth).toEqual({ type: "apiKey" });
		expect(ui.saved()?.previousId).toBe("legacy");
		ui.unmount();
	});
});
