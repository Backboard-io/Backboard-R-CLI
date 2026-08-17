import { describe, expect, it } from "bun:test";
import {
	IMAGE_PAYLOAD_BASE64_KEY,
	IMAGE_PAYLOAD_MEDIA_TYPE_KEY,
	ImageContent,
} from "../src/core/image/ImageContent.ts";

describe("ImageContent", () => {
	it("builds a payload from bytes", () => {
		const bytes = Buffer.from("hello", "utf8");
		const payload = ImageContent.fromBytes(bytes, "image/png");
		expect(payload[IMAGE_PAYLOAD_BASE64_KEY]).toBe(
			Buffer.from("hello", "utf8").toString("base64"),
		);
		expect(payload[IMAGE_PAYLOAD_MEDIA_TYPE_KEY]).toBe("image/png");
	});

	it("builds a payload from a Uint8Array", () => {
		const payload = ImageContent.fromBytes(
			new Uint8Array([1, 2, 3]),
			"image/png",
		);
		expect(payload[IMAGE_PAYLOAD_MEDIA_TYPE_KEY]).toBe("image/png");
		expect(payload[IMAGE_PAYLOAD_BASE64_KEY]).toBe(
			Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
		);
	});

	it("builds a payload from a base64 string", () => {
		const payload = ImageContent.fromBase64("YWJj", "image/png");
		expect(payload[IMAGE_PAYLOAD_BASE64_KEY]).toBe("YWJj");
		expect(payload[IMAGE_PAYLOAD_MEDIA_TYPE_KEY]).toBe("image/png");
	});

	it("renders a payload as a data: URI", () => {
		const uri = ImageContent.toDataUri({
			__image_base64: "YWJj",
			__image_media_type: "image/png",
		});
		expect(uri).toBe("data:image/png;base64,YWJj");
	});

	it("recognizes a standardized payload via the type guard", () => {
		expect(
			ImageContent.isImagePayload({
				__image_base64: "YWJj",
				__image_media_type: "image/png",
			}),
		).toBe(true);
	});

	it("rejects non-payload values via the type guard", () => {
		expect(ImageContent.isImagePayload(null)).toBe(false);
		expect(ImageContent.isImagePayload("string")).toBe(false);
		expect(ImageContent.isImagePayload(undefined)).toBe(false);
		expect(ImageContent.isImagePayload({ __image_base64: "x" })).toBe(false);
		expect(
			ImageContent.isImagePayload({
				__image_base64: 123,
				__image_media_type: "image/png",
			}),
		).toBe(false);
		expect(
			ImageContent.isImagePayload({
				__image_base64: "x",
				__image_media_type: 123,
			}),
		).toBe(false);
		expect(
			ImageContent.isImagePayload({
				__image_base64: "x",
				__image_media_type: "image/png",
				extra: true,
			}),
		).toBe(true);
	});
});
