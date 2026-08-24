// Bun bundles `with { type: "text" }` imports into the compiled binary, which
// is how the native computer-use helpers (Swift on macOS, PowerShell on
// Windows) ship without a separate asset directory.
declare module "*.swift" {
	const source: string;
	export default source;
}

declare module "*.ps1" {
	const source: string;
	export default source;
}
