import type { ScreenSize } from "./types.ts";

/** Reads the pixel dimensions from a PNG or JPEG header. */
export function imageSize(bytes: Buffer, label: string): ScreenSize {
	if (
		bytes.length >= 24 &&
		bytes.toString("ascii", 1, 4) === "PNG" &&
		bytes.toString("ascii", 12, 16) === "IHDR"
	) {
		return {
			width: bytes.readUInt32BE(16),
			height: bytes.readUInt32BE(20),
		};
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = bytes[offset + 1] ?? 0;
			if (
				marker === 0xd8 ||
				marker === 0x01 ||
				(marker >= 0xd0 && marker <= 0xd7)
			) {
				offset += 2;
				continue;
			}
			const length = bytes.readUInt16BE(offset + 2);
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					height: bytes.readUInt16BE(offset + 5),
					width: bytes.readUInt16BE(offset + 7),
				};
			}
			offset += 2 + length;
		}
	}
	throw new Error(`${label} is not a valid PNG or JPEG`);
}

/** @deprecated use imageSize */
export const pngSize = imageSize;
