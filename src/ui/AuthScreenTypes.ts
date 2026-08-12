import type { BackboardDeviceCodeResponse } from "../core/auth/BackboardOAuth.ts";
import type { ProviderKeyController } from "../core/keys/ProviderKeyController.ts";

export type AuthAction = "login" | "byok" | "exit";

export type AuthScreenMode = "select" | "loading" | "byok";

export type AuthDeviceCodeHandler = (
	response: BackboardDeviceCodeResponse,
) => void;

export type AuthLoginHandler = (
	onDeviceCode?: AuthDeviceCodeHandler,
) => Promise<string>;

export interface AuthScreenProps {
	onLogin: AuthLoginHandler;
	/** Drives the BYOK branch; omit to offer Backboard sign-in only. */
	keys?: ProviderKeyController;
	/** Called once a provider key is saved, so startup can retry with it. */
	onKeySaved?: () => void;
}
