import { describe, expect, it } from "bun:test";
import { ensureAssistant } from "../src/providers/backboard/assistants.ts";
import type { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type { AssistantInfo } from "../src/providers/backboard/types.ts";

interface Recorded {
	listed: number;
	createdNames: string[];
}

function stubClient(
	existing: AssistantInfo[],
	recorded: Recorded,
): BackboardClient {
	let counter = 0;
	return {
		async listAssistants() {
			recorded.listed++;
			return existing;
		},
		async createAssistant(req: { name: string }) {
			recorded.createdNames.push(req.name);
			counter++;
			return { assistant_id: `created_${counter}`, name: req.name };
		},
	} as unknown as BackboardClient;
}

describe("ensureAssistant", () => {
	it("reuses an assistant matching the fingerprint by default", async () => {
		const recorded: Recorded = { listed: 0, createdNames: [] };
		const client = stubClient([], recorded);

		const first = await ensureAssistant(client, "system", []);
		const createdName = recorded.createdNames[0] ?? "";
		// Second call finds the created one by name and reuses it.
		const reuseClient = stubClient(
			[{ assistant_id: first, name: createdName }],
			recorded,
		);
		const second = await ensureAssistant(reuseClient, "system", []);

		expect(second).toBe(first);
		expect(recorded.createdNames).toHaveLength(1);
	});

	it("creates a fresh, uniquely named assistant when fresh is set", async () => {
		const recorded: Recorded = { listed: 0, createdNames: [] };
		const existingName = "coding shared";
		const client = stubClient(
			[{ assistant_id: "shared", name: existingName }],
			recorded,
		);

		const a = await ensureAssistant(client, "system", [], { fresh: true });
		const b = await ensureAssistant(client, "system", [], { fresh: true });

		expect(a).not.toBe("shared");
		expect(recorded.listed).toBe(0);
		expect(recorded.createdNames).toHaveLength(2);
		expect(recorded.createdNames[0]).not.toBe(recorded.createdNames[1]);
		expect(a).not.toBe(b);
	});
});
