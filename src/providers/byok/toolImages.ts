import {
	IMAGE_PAYLOAD_BASE64_KEY,
	IMAGE_PAYLOAD_MEDIA_TYPE_KEY,
	ImageContent,
	type ImageContentPayload,
} from "../../core/image/ImageContent.ts";
import type { ByokMessage } from "./ByokTypes.ts";

export interface ToolOutputImage {
	mediaType: string;
	base64: string;
}

export interface SplitToolOutput {
	/** The tool output with image payloads replaced by short markers. */
	text: string;
	images: ToolOutputImage[];
}

/** Screenshots older than this many tool results are dropped from context. */
export const DEFAULT_TOOL_IMAGES_TO_KEEP = 3;

const MAX_DEPTH = 5;
export const STANDARD_TOOL_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);
export const GOOGLE_TOOL_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/heic",
	"image/heif",
]);

/** Text that accompanies tool images when they cannot live inside the tool message. */
export const TOOL_IMAGE_NOTE =
	"Screenshot(s) returned by the preceding tool result(s), in order.";

/**
 * Tools that observe the screen (Computer, Browser, Read on an image) embed
 * images in their JSON output as `__image_base64` / `__image_media_type`.
 * Backboard's server lifts those into real image blocks; BYOK adapters must
 * do the same, or the model receives hundreds of kilobytes of base64 as text
 * — which both blinds it and costs ~50k tokens per screenshot.
 */
export function splitToolOutputImages(
	output: string,
	acceptedMediaTypes: ReadonlySet<string> = STANDARD_TOOL_IMAGE_MEDIA_TYPES,
): SplitToolOutput {
	if (!output.includes(IMAGE_PAYLOAD_BASE64_KEY)) {
		return { text: output, images: [] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return { text: output, images: [] };
	}
	const images: ToolOutputImage[] = [];
	const state = { foundPayload: false };
	const stripped = strip(parsed, images, state, acceptedMediaTypes, 0);
	if (!state.foundPayload) return { text: output, images: [] };
	return { text: JSON.stringify(stripped), images };
}

function strip(
	value: unknown,
	images: ToolOutputImage[],
	state: { foundPayload: boolean },
	acceptedMediaTypes: ReadonlySet<string>,
	depth: number,
): unknown {
	if (depth > MAX_DEPTH || typeof value !== "object" || value === null) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			strip(item, images, state, acceptedMediaTypes, depth + 1),
		);
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	if (ImageContent.isImagePayload(record)) {
		state.foundPayload = true;
		const payload = record as ImageContentPayload;
		const mediaType = payload[IMAGE_PAYLOAD_MEDIA_TYPE_KEY];
		if (acceptedMediaTypes.has(mediaType)) {
			images.push({
				mediaType,
				base64: payload[IMAGE_PAYLOAD_BASE64_KEY],
			});
			out.__image = `attached as image ${images.length}`;
		} else {
			out.__image = `omitted: unsupported image format ${mediaType}`;
		}
	}
	for (const [key, child] of Object.entries(record)) {
		if (
			key === IMAGE_PAYLOAD_BASE64_KEY ||
			key === IMAGE_PAYLOAD_MEDIA_TYPE_KEY
		) {
			continue;
		}
		out[key] = strip(child, images, state, acceptedMediaTypes, depth + 1);
	}
	return out;
}

/**
 * Decides which tool results may still carry their images: the most recent
 * `keep` image-bearing results. Older ones keep only the text (with a marker),
 * so a long computer-use loop does not resend every screenshot ever taken.
 * Returns a set of `"<messageIndex>:<resultIndex>"` keys.
 */
export function planToolImages(
	messages: readonly ByokMessage[],
	keep = DEFAULT_TOOL_IMAGES_TO_KEEP,
	acceptedMediaTypes: ReadonlySet<string> = STANDARD_TOOL_IMAGE_MEDIA_TYPES,
): Set<string> {
	const allowed = new Set<string>();
	let remaining = keep;
	for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
		const message = messages[index];
		if (message?.role !== "tool") continue;
		for (let r = message.results.length - 1; r >= 0 && remaining > 0; r--) {
			const output = message.results[r]?.output ?? "";
			if (!output.includes(IMAGE_PAYLOAD_BASE64_KEY)) continue;
			if (splitToolOutputImages(output, acceptedMediaTypes).images.length === 0)
				continue;
			allowed.add(`${index}:${r}`);
			remaining--;
		}
	}
	return allowed;
}

/**
 * Renders one tool result for a provider: text for the tool message and the
 * images to attach (empty when this result is past the keep window).
 */
export function renderToolResult(
	output: string,
	withImages: boolean,
	acceptedMediaTypes: ReadonlySet<string> = STANDARD_TOOL_IMAGE_MEDIA_TYPES,
	omittedReason = "older screenshot",
): SplitToolOutput {
	const split = splitToolOutputImages(output, acceptedMediaTypes);
	if (withImages || split.images.length === 0) return split;
	return {
		text: split.text.replaceAll(
			/"attached as image \d+"/g,
			`"omitted: ${omittedReason}"`,
		),
		images: [],
	};
}

export function imageDataUri(image: ToolOutputImage): string {
	return `data:${image.mediaType};base64,${image.base64}`;
}
