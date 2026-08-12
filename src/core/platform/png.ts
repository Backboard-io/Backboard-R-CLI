import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImagePayload, ResizePngInput, ScreenSize } from "./types.ts";

const RESIZE_WIDTHS = [1280, 960, 720, 540, 360];

export async function resizeWithCandidates(
	input: ResizePngInput,
	resize: (width: number, out: string) => Promise<void>,
): Promise<ImagePayload | null> {
	const dir = await mkdtemp(join(tmpdir(), "q-cua-image-"));
	try {
		let smallest: ImagePayload | null = null;
		for (const width of RESIZE_WIDTHS) {
			if (width >= input.screenSize.width) continue;
			const out = join(dir, `screen-${width}.png`);
			await resize(width, out);
			const bytes = await readFile(out);
			const imageSize = pngSize(bytes, "resized screenshot");
			const payload = {
				bytes,
				imageSize,
				scale: imageSize.width / input.screenSize.width,
				compressed: true,
			};
			smallest = payload;
			if (bytes.byteLength <= input.maxBytes) return payload;
		}
		return smallest && smallest.bytes.byteLength <= input.maxBytes
			? smallest
			: null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export function pngSize(bytes: Buffer, label: string): ScreenSize {
	if (
		bytes.length < 24 ||
		bytes.toString("ascii", 1, 4) !== "PNG" ||
		bytes.toString("ascii", 12, 16) !== "IHDR"
	) {
		throw new Error(`${label} is not a valid PNG`);
	}
	return {
		width: bytes.readUInt32BE(16),
		height: bytes.readUInt32BE(20),
	};
}
