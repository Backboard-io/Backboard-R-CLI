import { parse } from "uri-template";
import type { Template } from "uri-template/dist/ast";

export type McpResourceTemplateVariable = {
	name: string;
	required: boolean;
};

export function resourceTemplateVariables(
	uriTemplate: string,
): McpResourceTemplateVariable[] {
	const variables = new Map<string, McpResourceTemplateVariable>();
	for (const part of templateAst(uriTemplate).parts ?? []) {
		if (part.type !== "expression") continue;
		const required = part.operator !== "?" && part.operator !== "&";
		for (const variable of part.variables ?? []) {
			const previous = variables.get(variable.name);
			variables.set(variable.name, {
				name: variable.name,
				required: previous ? previous.required || required : required,
			});
		}
	}
	return [...variables.values()];
}

export function resourceTemplateVariableNames(uriTemplate: string): string[] {
	return resourceTemplateVariables(uriTemplate).map(
		(variable) => variable.name,
	);
}

export function expandResourceTemplate(
	uriTemplate: string,
	values: Record<string, string>,
): string {
	return parse(uriTemplate).expand(values);
}

function templateAst(uriTemplate: string): Template {
	return parse(uriTemplate).ast;
}
