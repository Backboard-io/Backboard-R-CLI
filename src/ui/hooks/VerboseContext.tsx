import type React from "react";
import { createContext, useContext } from "react";

// Whether tool-call rows render their expanded output preview. Defaults to true
// so components rendered outside a provider (e.g. in tests) keep the full view.
const VerboseContext = createContext<boolean>(true);

export function VerboseProvider({
	verbose,
	children,
}: {
	verbose: boolean;
	children?: React.ReactNode;
}): React.ReactElement {
	return (
		<VerboseContext.Provider value={verbose}>
			{children}
		</VerboseContext.Provider>
	);
}

export function useVerbose(): boolean {
	return useContext(VerboseContext);
}
