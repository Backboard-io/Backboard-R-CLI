export const READ_TOOL_MAX_BYTES = 5 * 1024 * 1024;
export const READ_TOOL_DEFAULT_LINE_LIMIT = 2400;

export const READ_TOOL_IMAGE_MIME_BY_EXTENSION: ReadonlyMap<string, string> =
	new Map([
		[".png", "image/png"],
		[".jpg", "image/jpeg"],
		[".jpeg", "image/jpeg"],
		[".webp", "image/webp"],
		[".gif", "image/gif"],
		[".bmp", "image/bmp"],
		[".tif", "image/tiff"],
		[".tiff", "image/tiff"],
		[".avif", "image/avif"],
		[".heic", "image/heic"],
		[".heif", "image/heif"],
		[".ico", "image/x-icon"],
	]);

export const READ_TOOL_SUPPORTED_IMAGE_EXTENSIONS = [
	...READ_TOOL_IMAGE_MIME_BY_EXTENSION.keys(),
].sort();
