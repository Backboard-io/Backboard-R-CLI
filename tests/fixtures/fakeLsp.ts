/**
 * Minimal LSP server used by tests. Speaks JSON-RPC over stdio, answers the
 * initialize handshake, and publishes a single error diagnostic whenever a
 * document is opened or changed. This lets us exercise the real LspClient /
 * LspService pipeline without depending on a language toolchain.
 */
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
);

connection.onRequest("initialize", () => ({
	capabilities: { textDocumentSync: 1 },
}));
connection.onNotification("initialized", () => {});

function publish(uri: string): void {
	void connection.sendNotification("textDocument/publishDiagnostics", {
		uri,
		diagnostics: [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 4 },
				},
				severity: 1,
				code: "E001",
				message: "fake diagnostic",
			},
		],
	});
}

connection.onNotification(
	"textDocument/didOpen",
	(params: { textDocument: { uri: string } }) => {
		publish(params.textDocument.uri);
	},
);
connection.onNotification(
	"textDocument/didChange",
	(params: { textDocument: { uri: string } }) => {
		publish(params.textDocument.uri);
	},
);
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
