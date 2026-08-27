import { describe, expect, it } from "bun:test";
import { ImageContent } from "../src/core/image/ImageContent.ts";
import { toAnthropicMessages } from "../src/providers/byok/adapters/AnthropicAdapter.ts";
import { renderGoogleContents } from "../src/providers/byok/adapters/GoogleAdapter.ts";
import {
	openAIModelAcceptsImages,
	toOpenAIMessages,
} from "../src/providers/byok/adapters/OpenAIAdapter.ts";
import { toOpenRouterMessages } from "../src/providers/byok/adapters/OpenRouterAdapter.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
} from "../src/providers/byok/ByokTypes.ts";
import {
	GOOGLE_TOOL_IMAGE_MEDIA_TYPES,
	planToolImages,
	renderToolResult,
	splitToolOutputImages,
	TOOL_IMAGE_NOTE,
} from "../src/providers/byok/toolImages.ts";

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6py3wAAAABJRU5ErkJggg==";

function observation(id: string) {
	return JSON.stringify({
		success: true,
		results: [{ success: true, action: "click", summary: "Clicked." }],
		observation: {
			observationId: id,
			screenSize: { width: 10, height: 10 },
			elements: [],
			...ImageContent.fromBase64(PNG, "image/png"),
		},
	});
}

function transcript(screenshots: number): ByokMessage[] {
	const messages: ByokMessage[] = [{ role: "user", content: "go" }];
	for (let i = 0; i < screenshots; i++) {
		messages.push(
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: `call_${i}`, name: "computer", input: {} }],
			},
			{
				role: "tool",
				results: [
					{
						id: `call_${i}`,
						name: "computer",
						output: observation(`obs_${i}`),
					},
				],
			},
		);
	}
	return messages;
}

function request(messages: ByokMessage[]): ByokStreamRequest {
	return { model: "m", systemPrompt: "sys", tools: [], messages };
}

describe("splitToolOutputImages", () => {
	it("lifts nested image payloads out of tool JSON", () => {
		const split = splitToolOutputImages(observation("obs_1"));
		expect(split.images).toEqual([{ mediaType: "image/png", base64: PNG }]);
		expect(split.text).not.toContain("__image_base64");
		expect(split.text).toContain('"__image":"attached as image 1"');
		expect(JSON.parse(split.text).observation.observationId).toBe("obs_1");
	});

	it("leaves outputs without images untouched", () => {
		expect(splitToolOutputImages("plain text")).toEqual({
			text: "plain text",
			images: [],
		});
		expect(splitToolOutputImages('{"a":1}')).toEqual({
			text: '{"a":1}',
			images: [],
		});
		expect(splitToolOutputImages("not json __image_base64")).toEqual({
			text: "not json __image_base64",
			images: [],
		});
	});

	it("omits image formats provider APIs do not accept", () => {
		const output = JSON.stringify({
			image: ImageContent.fromBase64("AA==", "image/tiff"),
		});
		const split = splitToolOutputImages(output);
		expect(split.images).toEqual([]);
		expect(split.text).toContain(
			"omitted: unsupported image format image/tiff",
		);
		expect(split.text).not.toContain("AA==");

		const messages = transcript(2);
		const latest = messages[4];
		if (latest?.role !== "tool") throw new Error("expected tool message");
		const latestResult = latest.results[0];
		if (!latestResult) throw new Error("expected tool result");
		latestResult.output = output;
		expect([...planToolImages(messages, 1)]).toEqual(["2:0"]);
	});

	it("uses Gemini's image MIME capabilities", () => {
		const gif = JSON.stringify({
			image: ImageContent.fromBase64("R0lG", "image/gif"),
		});
		const heic = JSON.stringify({
			image: ImageContent.fromBase64("aGVpYw==", "image/heic"),
		});
		expect(splitToolOutputImages(gif).images).toHaveLength(1);
		expect(
			splitToolOutputImages(gif, GOOGLE_TOOL_IMAGE_MEDIA_TYPES).images,
		).toHaveLength(0);
		expect(splitToolOutputImages(heic).images).toHaveLength(0);
		expect(
			splitToolOutputImages(heic, GOOGLE_TOOL_IMAGE_MEDIA_TYPES).images,
		).toEqual([{ mediaType: "image/heic", base64: "aGVpYw==" }]);
	});

	it("keeps only the most recent screenshots as images", () => {
		const messages = transcript(5);
		const plan = planToolImages(messages, 3);
		expect([...plan].sort()).toEqual(["10:0", "6:0", "8:0"]);
		const older = renderToolResult(observation("obs_0"), false);
		expect(older.images).toHaveLength(0);
		expect(older.text).toContain("omitted: older screenshot");
		expect(older.text).not.toContain(PNG);
	});
});

describe("BYOK adapters attach tool images natively", () => {
	it("OpenAI and OpenRouter add a user message with image parts after tool results", () => {
		for (const render of [toOpenAIMessages, toOpenRouterMessages]) {
			const out = render(request(transcript(1))) as Array<
				Record<string, unknown>
			>;
			const tool = out.find((m) => m.role === "tool") as { content: string };
			expect(tool.content).not.toContain(PNG);
			const follow = out[out.indexOf(tool as never) + 1] as {
				role: string;
				content: unknown[];
			};
			expect(follow.role).toBe("user");
			expect(follow.content[0]).toEqual({
				type: "text",
				text: TOOL_IMAGE_NOTE,
			});
			expect(follow.content[1]).toEqual({
				type: "image_url",
				image_url: { url: `data:image/png;base64,${PNG}` },
			});
			expect(JSON.stringify(out).split(PNG).length - 1).toBe(1);
		}
	});

	it("omits screenshots for text-only OpenRouter models", () => {
		const out = toOpenRouterMessages(request(transcript(1)), false) as Array<
			Record<string, unknown>
		>;
		expect(JSON.stringify(out)).not.toContain(PNG);
		expect(JSON.stringify(out)).toContain("model does not accept images");
		expect(out.some((message) => message.role === "user")).toBe(true);
	});

	it("omits user image attachments for text-only OpenRouter models", () => {
		const messages: ByokMessage[] = [
			{
				role: "user",
				content: "inspect this",
				attachments: [
					{
						path: "image.png",
						mediaType: "image/png",
						base64: PNG,
					},
				],
			},
		];
		const out = toOpenRouterMessages(request(messages), false);
		expect(JSON.stringify(out)).not.toContain(PNG);
		expect(JSON.stringify(out)).toContain("does not accept images");
	});

	it("omits images for text-only OpenAI models", () => {
		for (const model of [
			"gpt-3.5-turbo",
			"gpt-4",
			"gpt-4-0613",
			"gpt-4-32k-0613",
			"gpt-4-0125-preview",
			"ft:gpt-4-0613:org:custom-name",
			"o1-mini",
			"o3-mini-2025-01-31",
		]) {
			expect(openAIModelAcceptsImages(model)).toBe(false);
		}
		const out = toOpenAIMessages({
			...request(transcript(1)),
			model: "gpt-3.5-turbo",
		});
		expect(JSON.stringify(out)).not.toContain(PNG);
		expect(JSON.stringify(out)).toContain("model does not accept images");
	});

	it("Anthropic puts image blocks inside tool_result", () => {
		const out = toAnthropicMessages(transcript(1)) as Array<{
			role: string;
			content: Array<Record<string, unknown>>;
		}>;
		const result = out.at(-1)?.content[0] as {
			content: Array<Record<string, unknown>>;
		};
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: PNG },
		});
	});

	it("Gemini appends inlineData parts after functionResponse", () => {
		const out = renderGoogleContents(transcript(1)) as Array<{
			parts: Array<Record<string, unknown>>;
		}>;
		const parts = out.at(-1)?.parts ?? [];
		expect(parts[0]).toHaveProperty("functionResponse");
		expect(parts[1]).toEqual({ text: TOOL_IMAGE_NOTE });
		expect(parts[2]).toEqual({
			inlineData: { mimeType: "image/png", data: PNG },
		});
	});

	it("drops images from results older than the keep window everywhere", () => {
		const messages = transcript(5);
		for (const rendered of [
			toOpenAIMessages(request(messages)),
			toOpenRouterMessages(request(messages)),
			toAnthropicMessages(messages),
			renderGoogleContents(messages),
		]) {
			expect(JSON.stringify(rendered).split(PNG).length - 1).toBe(3);
		}
	});
});
