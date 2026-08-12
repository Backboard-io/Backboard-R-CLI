import type { AttachmentItem } from "./AttachmentTypes.ts";
import type { CandidateFile } from "./attachmentPaths.ts";

/** Local staging for pending prompt attachments, consumed at submit. */
export class AttachmentManager {
	private readonly entries = new Map<string, AttachmentItem>();
	private readonly listeners = new Set<() => void>();
	private snapshot: readonly AttachmentItem[] = [];
	private counter = 0;

	add(files: CandidateFile[]): AttachmentItem[] {
		const added: AttachmentItem[] = [];
		for (const file of files) {
			const item: AttachmentItem = {
				id: `att-${++this.counter}`,
				filePath: file.filePath,
				fileName: file.fileName,
				sizeBytes: file.sizeBytes,
				label: this.nextLabel(),
			};
			this.entries.set(item.id, item);
			added.push(item);
		}
		this.notify();
		return added;
	}

	remove(id: string): AttachmentItem | undefined {
		const item = this.entries.get(id);
		if (!item) return undefined;
		this.entries.delete(id);
		this.notify();
		return item;
	}

	/** Hands staged files to a submitted message: chips cleared, paths returned. */
	consume(ids: string[]): string[] {
		const paths: string[] = [];
		for (const id of ids) {
			const item = this.entries.get(id);
			if (!item) continue;
			paths.push(item.filePath);
			this.entries.delete(id);
		}
		if (paths.length > 0) this.notify();
		return paths;
	}

	/** Discards every staged attachment (used by /new). */
	clearAll(): AttachmentItem[] {
		const removed = [...this.entries.values()];
		if (removed.length === 0) return removed;
		this.entries.clear();
		this.notify();
		return removed;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): readonly AttachmentItem[] => this.snapshot;

	private notify(): void {
		this.snapshot = [...this.entries.values()];
		for (const listener of this.listeners) listener();
	}

	/** `[attachment #N]`, N = lowest number free among the active chips. */
	private nextLabel(): string {
		const taken = new Set([...this.entries.values()].map((item) => item.label));
		let n = 1;
		while (taken.has(`[attachment #${n}]`)) n++;
		return `[attachment #${n}]`;
	}
}
