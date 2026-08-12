/** Mirrors the server's ALLOWED_EXTENSIONS (app/routers/documents.py). */
export const ALLOWED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
	// Documents
	".pdf",
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx",
	// Text / Data
	".txt",
	".csv",
	".md",
	".markdown",
	".json",
	".jsonl",
	".xml",
	// Code
	".py",
	".js",
	".ts",
	".jsx",
	".tsx",
	".html",
	".css",
	".cpp",
	".c",
	".h",
	".java",
	".go",
	".rs",
	".rb",
	".php",
	".sql",
	// Images
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".bmp",
	".tiff",
	".tif",
	// Audio
	".mp3",
	".wav",
	".m4a",
	".ogg",
	".flac",
	".aac",
	// Video
	".mp4",
	".mov",
	".avi",
	".mkv",
	".mpeg",
	".mpg",
	".webm",
]);

/** Server-side MAX_ATTACHMENT_FILE_SIZE_BYTES for inline message attachments. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Server-side MAX_ATTACHMENTS_PER_MESSAGE. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
