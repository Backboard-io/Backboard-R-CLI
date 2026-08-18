export function quotePowerShellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
