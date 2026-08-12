export interface ToolResultDetailLine {
	key: string;
	displayValue: string;
	highlighted: boolean;
	kind?: "added" | "removed" | "neutral";
}
