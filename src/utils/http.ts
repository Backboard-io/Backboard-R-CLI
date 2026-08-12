export interface LimitedTextResult {
	text: string;
	truncated: boolean;
}

export async function readLimitedResponseText(
	response: Response,
	maxBytes: number,
): Promise<LimitedTextResult> {
	if (!response.body) {
		return { text: await response.text(), truncated: false };
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let bytes = 0;
	let truncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const remaining = maxBytes - bytes;
			if (value.byteLength > remaining) {
				if (remaining > 0) {
					chunks.push(
						decoder.decode(value.slice(0, remaining), { stream: true }),
					);
				}
				truncated = true;
				await reader.cancel();
				break;
			}

			bytes += value.byteLength;
			chunks.push(decoder.decode(value, { stream: true }));
		}
	} finally {
		reader.releaseLock();
	}

	if (!truncated) chunks.push(decoder.decode());
	return { text: chunks.join(""), truncated };
}
