import type React from "react";
import { createContext, useContext } from "react";
import { defaultTheme, type Theme } from "./theme.ts";

const ThemeContext = createContext<Theme>(defaultTheme);

// Callers are expected to setTheme(value) once when the theme is created
// (see entrypoints/cli.tsx) — a side effect in the render body would break
// under StrictMode/concurrent rendering.
export function ThemeProvider({
	children,
	value,
}: {
	children: React.ReactNode;
	value: Theme;
}): React.ReactElement {
	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): Theme {
	return useContext(ThemeContext);
}
