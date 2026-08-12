import type React from "react";

export type PromptSurfaceState = "idle" | "active" | "submitted";

export interface PromptSurfaceProps {
	children: React.ReactNode;
	state?: PromptSurfaceState;
}
