import { describe, expect, it } from "bun:test";
import type { BackboardThread } from "../src/providers/backboard/types.ts";
import { filterItems } from "../src/ui/components/Picker.tsx";
import { sessionTabs } from "../src/ui/components/SessionsSelector.tsx";

describe("sessionTabs", () => {
	it("shows one date and a compact ID while keeping full IDs searchable", () => {
		const thread: BackboardThread = {
			thread_id: "thread_1234567890abcdef",
			title: "Resume work",
			message_count: 4,
			created_at: "2026-08-17T10:00:00Z",
			updated_at: "2026-08-18T11:30:00Z",
			metadata_: { backboard_session_id: "sess_1234abcd" },
			messages: [],
		};
		const item = sessionTabs([thread])[0]?.items[0];
		if (!item) throw new Error("expected a session picker item");
		expect(item.status).toBeUndefined();
		expect(item.description).toContain("8/18");
		expect(item?.badge).toContain("thread_1234…");
		expect(item?.badge).toContain("4 msg");
		expect(filterItems([item], "thread_1234567890abcdef")).toHaveLength(1);
		expect(filterItems([item], "sess_1234abcd")).toHaveLength(1);
	});
});
