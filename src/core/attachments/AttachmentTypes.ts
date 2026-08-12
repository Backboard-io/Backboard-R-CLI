export interface AttachmentItem {
	id: string;
	filePath: string;
	fileName: string;
	sizeBytes: number;
	/** Inline chip text inserted into the prompt, stable across renames. */
	label: string;
}
