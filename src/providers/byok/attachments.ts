import { basename, extname } from "node:path";
import type { ByokAttachment } from "./ByokTypes.ts";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

/** Text attachments above this are truncated rather than blowing the context. */
const MAX_INLINE_TEXT_BYTES = 64 * 1024;

/**
 * Backboard uploads attachments as multipart and resolves them server-side.
 * Vendor APIs have no such endpoint, so files are inlined into the message:
 * images as base64 parts, anything else as truncated text.
 */
export async function loadAttachments(
	filePaths: readonly string[],
): Promise<ByokAttachment[]> {
	const attachments: ByokAttachment[] = [];
	for (const path of filePaths) {
		const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
		try {
			const file = Bun.file(path);
			if (mediaType) {
				const buffer = Buffer.from(await file.arrayBuffer());
				attachments.push({
					path: basename(path),
					mediaType,
					base64: buffer.toString("base64"),
				});
				continue;
			}
			const text = await file.text();
			attachments.push({
				path: basename(path),
				mediaType: "text/plain",
				text:
					text.length > MAX_INLINE_TEXT_BYTES
						? `${text.slice(0, MAX_INLINE_TEXT_BYTES)}\n… (truncated)`
						: text,
			});
		} catch {
			// An unreadable attachment must not fail the turn - the model simply
			// does not see it.
		}
	}
	return attachments;
}
