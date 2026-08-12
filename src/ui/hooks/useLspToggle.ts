import { useCallback, useRef, useState } from "react";
import { errorMessage } from "../../utils/errors.ts";

export interface LspToggleService {
	toggleEnabled(): Promise<boolean>;
}

/**
 * Single-flight LSP toggle shared by the /lsp command and the settings panel.
 * The ref guard is read synchronously, so a second invocation before the next
 * render cannot start an overlapping toggle; `lspPending` drives the panel's
 * in-flight row state.
 */
export function useLspToggle(
	lsp: LspToggleService,
	notice: (text: string, level?: "info" | "warning" | "error") => void,
): {
	toggleLsp: (opts?: { silent?: boolean }) => void;
	lspPending: boolean;
} {
	const [lspPending, setLspPending] = useState(false);
	const pendingRef = useRef(false);
	const toggleLsp = useCallback(
		(opts?: { silent?: boolean }) => {
			if (pendingRef.current) return;
			pendingRef.current = true;
			setLspPending(true);
			void lsp
				.toggleEnabled()
				.then((enabled) => {
					if (opts?.silent) return;
					notice(
						`LSP diagnostics ${enabled ? "enabled" : "disabled"} for this session.`,
					);
				})
				.catch((err) => {
					notice(
						`Failed to toggle LSP diagnostics: ${errorMessage(err)}`,
						"error",
					);
				})
				.finally(() => {
					pendingRef.current = false;
					setLspPending(false);
				});
		},
		[lsp, notice],
	);
	return { toggleLsp, lspPending };
}
