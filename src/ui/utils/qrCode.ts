import { create } from "qrcode";

// Level L fits the https:// device-login URL at the smallest QR version (v4, 33x33).
const ERROR_CORRECTION_LEVEL = "L";

// Render as unicode half-blocks: each char packs two vertically stacked modules.
export function renderQrCodeLines(text: string): string[] {
	if (!text) {
		return [];
	}
	const { modules } = create(text, {
		errorCorrectionLevel: ERROR_CORRECTION_LEVEL,
	});
	const size = modules.size;
	const dark = (x: number, y: number): boolean =>
		y < size && modules.data[y * size + x] === 1;
	const lines: string[] = [];
	for (let y = 0; y < size; y += 2) {
		let line = "";
		for (let x = 0; x < size; x++) {
			const top = dark(x, y);
			const bottom = dark(x, y + 1);
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines;
}
