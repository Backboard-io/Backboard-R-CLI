import { describe, expect, it } from "bun:test";
import { buildRunMessageRequest } from "../src/core/agent/RunMessageRequestBuilder.ts";
import { Session } from "../src/core/session/Session.ts";

describe("buildRunMessageRequest", () => {
	it("includes the local workspace id in message metadata", () => {
		const request = buildRunMessageRequest("hello", {
			session: new Session("sess_test"),
			tools: [],
			systemPrompt: "system",
			assistantId: "asst_test",
			model: { provider: "openai", model: "gpt-5.5" },
			memory: "auto",
			memoryProfile: "code",
			workspaceId: "workspace_test",
		});

		expect(request.metadata).toEqual({
			backboard_workspace_id: "workspace_test",
		});
	});
});
