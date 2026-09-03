export interface EntryListItem {
	key: string;
	value: string;
	/** Caller-owned provenance retained while an entry is unchanged or renamed. */
	data?: unknown;
}

export interface EntryListEditorProps {
	title: string;
	help?: string;
	entries: readonly EntryListItem[];
	keyLabel: string;
	valueLabel?: string;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	isSecret?: (key: string) => boolean;
	validate?: (entry: EntryListItem) => void;
	onChange: (entries: EntryListItem[]) => void;
	onSubmit: () => void;
	onCancel: () => void;
}
