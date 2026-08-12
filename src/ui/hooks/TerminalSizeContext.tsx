import type React from "react";
import { createContext, useContext } from "react";
import type {
	TerminalSize,
	TerminalSizeProviderProps,
} from "./TerminalSizeContext.types.ts";

const DEFAULT_TERMINAL_SIZE: TerminalSize = {
	columns: 80,
	rows: 24,
};

const TerminalSizeContext = createContext<TerminalSize>(DEFAULT_TERMINAL_SIZE);

export function TerminalSizeProvider({
	size,
	children,
}: TerminalSizeProviderProps): React.ReactElement {
	return (
		<TerminalSizeContext.Provider value={size}>
			{children}
		</TerminalSizeContext.Provider>
	);
}

export function useTerminalSize(): TerminalSize {
	return useContext(TerminalSizeContext);
}
