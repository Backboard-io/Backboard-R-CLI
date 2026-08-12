import type React from "react";

export interface TerminalSize {
	columns: number;
	rows: number;
}

export interface TerminalSizeProviderProps {
	size: TerminalSize;
	children: React.ReactNode;
}
