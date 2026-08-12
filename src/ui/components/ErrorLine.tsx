import { Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";

/** The standard inline error line; renders nothing while there is no error. */
export function ErrorLine({
	error,
}: {
	error: string | null | undefined;
}): React.ReactElement | null {
	if (!error) return null;
	return <Text color={theme.error}>{error}</Text>;
}
