import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { APP_PACKAGE_NAME, APP_VERSION } from "../../config/branding.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { McpServerConfig } from "./config.ts";
import { listMcpServerToolDefinitionsIfSupported } from "./MCPToolDefinitions.ts";
import { createMcpTransport } from "./MCPTransport.ts";
import type {
	McpConnection,
	McpListedToolDefinition,
	McpServerRuntimeStatus,
} from "./MCPTypes.ts";
import { McpAuthenticationRequiredError, McpOAuthProvider } from "./oauth.ts";

export interface McpConnectResult {
	connection?: McpConnection;
	tools: McpListedToolDefinition[];
	status: McpServerRuntimeStatus;
	warnings: string[];
}

export interface McpServerConnectorOptions {
	cwd: string;
	onToolListChanged: (serverName: string) => void;
	onPromptListChanged: (serverName: string) => void;
	onResourceListChanged: (serverName: string) => void;
	onResourceUpdated: (serverName: string, uri: string) => void;
}

export class McpServerConnector {
	constructor(private readonly options: McpServerConnectorOptions) {}

	async connect(
		server: McpServerConfig,
		signal: AbortSignal,
		options: { interactiveAuth: boolean },
	): Promise<McpConnectResult> {
		const warnings: string[] = [];
		let client = this.createClient(server.name);
		let transport = null as McpConnection["transport"] | null;
		const authProvider =
			server.type === "http"
				? new McpOAuthProvider(server.name, options.interactiveAuth)
				: undefined;

		try {
			transport = createMcpTransport(server, this.options.cwd, authProvider);
			try {
				await client.connect(transport, { signal, timeout: server.timeoutMs });
			} catch (err) {
				if (!(err instanceof UnauthorizedError) || !authProvider) throw err;
				if (!(transport instanceof StreamableHTTPClientTransport)) throw err;

				const code = await authProvider.waitForAuthorizationCode(
					signal,
					server.timeoutMs,
				);
				await transport.finishAuth(code);
				await transport.close().catch(() => undefined);
				client = this.createClient(server.name);
				transport = createMcpTransport(server, this.options.cwd, authProvider);
				await client.connect(transport, { signal, timeout: server.timeoutMs });
			}

			const capabilities = client.getServerCapabilities() ?? {};
			let tools: McpListedToolDefinition[];
			try {
				tools = await listMcpServerToolDefinitionsIfSupported(
					server,
					client,
					capabilities,
					signal,
				);
			} catch (err) {
				if (!(err instanceof UnauthorizedError) || !authProvider) throw err;
				if (!(transport instanceof StreamableHTTPClientTransport)) throw err;
				const code = await authProvider.waitForAuthorizationCode(
					signal,
					server.timeoutMs,
				);
				await transport.finishAuth(code);
				tools = await listMcpServerToolDefinitionsIfSupported(
					server,
					client,
					capabilities,
					signal,
				);
			}
			authProvider?.closeCallbackServer();
			return {
				connection: {
					server,
					client,
					transport,
					tools: new Map(),
					prompts: new Map(),
					resources: new Map(),
					updatedResourceUris: new Set(),
					subscribedResourceUris: new Set(),
					capabilities,
				},
				tools,
				status: connectedStatus(server, capabilities),
				warnings,
			};
		} catch (err) {
			authProvider?.closeCallbackServer();
			const authRequired = isAuthRequired(err);
			if (
				authRequired ||
				(!options.interactiveAuth && isOAuthAuthFlowError(err))
			) {
				const message = authRequired
					? "Authentication required."
					: errorMessage(err);
				await transport?.close().catch(() => undefined);
				return {
					tools: [],
					status: statusFor(server, "needs_authentication", message),
					warnings: [`MCP server '${server.name}' requires authentication.`],
				};
			}

			const message = errorMessage(err);
			warnings.push(`Skipped MCP server '${server.name}': ${message}.`);
			await transport?.close().catch(() => undefined);
			return {
				tools: [],
				status: statusFor(server, "error", message),
				warnings,
			};
		}
	}

	private createClient(serverName: string): Client {
		const client = new Client(
			{ name: APP_PACKAGE_NAME, version: APP_VERSION },
			{
				listChanged: {
					tools: {
						autoRefresh: false,
						debounceMs: 0,
						onChanged: () => this.options.onToolListChanged(serverName),
					},
					prompts: {
						autoRefresh: false,
						debounceMs: 0,
						onChanged: () => this.options.onPromptListChanged(serverName),
					},
					resources: {
						autoRefresh: false,
						debounceMs: 0,
						onChanged: () => this.options.onResourceListChanged(serverName),
					},
				},
			},
		);
		client.setNotificationHandler(
			ResourceUpdatedNotificationSchema,
			(event) => {
				this.options.onResourceUpdated(serverName, event.params.uri);
			},
		);
		return client;
	}
}

function connectedStatus(
	server: McpServerConfig,
	capabilities: McpConnection["capabilities"],
): McpServerRuntimeStatus {
	return {
		name: server.name,
		type: server.type,
		configSources: [...server.configSources],
		status: "connected",
		toolNames: [],
		capabilities,
		promptNames: [],
		resourceUris: [],
		updatedResourceUris: [],
		subscribedResourceUris: [],
	};
}

function statusFor(
	server: McpServerConfig,
	status: "needs_authentication" | "error",
	message: string,
): McpServerRuntimeStatus {
	return {
		name: server.name,
		type: server.type,
		configSources: [...server.configSources],
		status,
		message,
		toolNames: [],
		capabilities: {},
		promptNames: [],
		resourceUris: [],
		updatedResourceUris: [],
		subscribedResourceUris: [],
	};
}

function isAuthRequired(err: unknown): boolean {
	return (
		err instanceof UnauthorizedError ||
		err instanceof McpAuthenticationRequiredError
	);
}

function isOAuthAuthFlowError(err: unknown): boolean {
	return (
		err instanceof Error && err.message.includes("Invalid OAuth error response")
	);
}
