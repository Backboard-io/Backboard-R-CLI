import { describe, expect, test } from "bun:test";
import { AttachmentManager } from "../src/core/attachments/AttachmentManager.ts";
import type { CandidateFile } from "../src/core/attachments/attachmentPaths.ts";

function candidate(name: string, dir = "/tmp"): CandidateFile {
	return {
		filePath: `${dir}/${name}`,
		fileName: name,
		sizeBytes: 42,
	};
}

describe("AttachmentManager", () => {
	test("add stages chips with sequential labels", () => {
		const m = new AttachmentManager();
		const [a, b] = m.add([candidate("a.png"), candidate("b.pdf")]);
		expect(a?.label).toBe("[attachment #1]");
		expect(b?.label).toBe("[attachment #2]");
		expect(m.getSnapshot()).toHaveLength(2);
	});

	test("labels reuse the lowest free number after removal", () => {
		const m = new AttachmentManager();
		const [a] = m.add([candidate("a.png")]);
		m.add([candidate("b.png")]);
		m.remove(a?.id ?? "");
		const [c] = m.add([candidate("c.png")]);
		expect(c?.label).toBe("[attachment #1]");
	});

	test("remove drops the chip and returns it", () => {
		const m = new AttachmentManager();
		const [a] = m.add([candidate("a.png")]);
		const removed = m.remove(a?.id ?? "");
		expect(removed?.filePath).toBe("/tmp/a.png");
		expect(m.getSnapshot()).toHaveLength(0);
		expect(m.remove("missing")).toBeUndefined();
	});

	test("consume returns file paths in id order and clears chips", () => {
		const m = new AttachmentManager();
		const [a, b] = m.add([candidate("a.png"), candidate("b.pdf")]);
		const paths = m.consume([b?.id ?? "", a?.id ?? ""]);
		expect(paths).toEqual(["/tmp/b.pdf", "/tmp/a.png"]);
		expect(m.getSnapshot()).toHaveLength(0);
	});

	test("consume ignores unknown ids", () => {
		const m = new AttachmentManager();
		const [a] = m.add([candidate("a.png")]);
		expect(m.consume(["missing", a?.id ?? ""])).toEqual(["/tmp/a.png"]);
	});

	test("clearAll discards every staged chip and returns them", () => {
		const m = new AttachmentManager();
		m.add([candidate("a.png"), candidate("b.pdf")]);
		const removed = m.clearAll();
		expect(removed.map((item) => item.filePath)).toEqual([
			"/tmp/a.png",
			"/tmp/b.pdf",
		]);
		expect(m.getSnapshot()).toHaveLength(0);
		expect(m.clearAll()).toEqual([]);
	});

	test("subscribe notifies on add, remove, consume", () => {
		const m = new AttachmentManager();
		let notified = 0;
		const unsubscribe = m.subscribe(() => {
			notified++;
		});
		const [a, b] = m.add([candidate("a.png"), candidate("b.pdf")]);
		m.remove(a?.id ?? "");
		m.consume([b?.id ?? ""]);
		unsubscribe();
		m.add([candidate("c.png")]);
		expect(notified).toBe(3);
	});
});
