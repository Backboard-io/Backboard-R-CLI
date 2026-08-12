import { providerKeyResolver } from "../config/auth.ts";
import type { Config } from "../config/Config.ts";
import type { ServerEventLog } from "../core/session/ServerEventLog.ts";
import type { AgentClient } from "./AgentClient.ts";
import { BackboardClient } from "./backboard/BackboardClient.ts";
import { ByokClient } from "./byok/ByokClient.ts";
import { ByokConversationStore } from "./byok/ByokConversationStore.ts";
import { ClientRouter } from "./ClientRouter.ts";

/**
 * Builds the model backend for a run from whatever credentials exist.
 *
 * Key lookups read `config.auth` at call time rather than being captured, so a
 * `/keys` toggle or a mid-session `/login` takes effect on the next request
 * without rebuilding the client or restarting the CLI.
 */
export function createAgentClient(
	config: Config,
	serverLog?: ServerEventLog,
): AgentClient {
	// Built unconditionally, even with no sign-in: it reads `config.env`, which
	// `refreshAuth()` mutates in place, so a mid-session `/login` makes it live
	// without rebuilding anything. Gating construction on the credential
	// present at startup would have left Backboard models unreachable until a
	// restart for anyone who started keys-only.
	const backboard = new BackboardClient(config.env, serverLog);
	const byok = new ByokClient(
		(provider) => providerKeyResolver(config.auth)(provider),
		serverLog,
		new ByokConversationStore(config.cwd),
	);

	return new ClientRouter({
		backboard,
		byok,
		getModel: () => config.model,
		hasBackboardAuth: () => config.hasBackboardAuth,
		hasKeyFor: (provider) =>
			config.auth.providerKeys.some((entry) => entry.provider === provider),
	});
}
