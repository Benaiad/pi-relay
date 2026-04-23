/**
 * Template instantiation — substitute parameters into a raw plan.
 *
 * `instantiateTemplate` is a pure function: it takes a `PlanTemplate` and
 * a caller-supplied `args` record, substitutes `{{name}}` placeholders in
 * every string value of the parsed plan object, validates the result against
 * `PlanDraftSchema`, and returns either a `TemplateInstantiation` or a
 * structured `TemplateError`.
 *
 * Substitution operates on the PARSED object (post-YAML), not on the raw
 * YAML string. This means argument values containing YAML special characters
 * (`"`, `:`, `\n`) cannot corrupt the document structure.
 */

import { Value } from "typebox/value";
import type { PlanDraftDoc } from "../plan/draft.js";
import { PlanDraftSchema } from "../plan/draft.js";
import { err, ok, type Result } from "../plan/result.js";
import type { TemplateError } from "./errors.js";
import type { PlanTemplate } from "./types.js";

export interface TemplateInstantiation {
	readonly plan: PlanDraftDoc;
	readonly templateName: string;
	readonly templateArgs: Readonly<Record<string, string>>;
}

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

export const instantiateTemplate = (
	template: PlanTemplate,
	args: Readonly<Record<string, string>>,
): Result<TemplateInstantiation, TemplateError> => {
	const missing: string[] = [];
	for (const param of template.parameters) {
		if (param.required && !(param.name in args)) {
			missing.push(param.name);
		}
	}
	if (missing.length > 0) {
		return err({
			kind: "missing_required_param",
			templateName: template.name,
			missing,
			provided: Object.keys(args),
		});
	}

	const substitutionMap = new Map<string, string>();
	for (const param of template.parameters) {
		substitutionMap.set(param.name, args[param.name] ?? "");
	}

	const cloned = structuredClone(template.rawPlan);
	substituteStrings(cloned, substitutionMap);

	const residual = findResidualPlaceholders(cloned, "");
	if (residual.length > 0) {
		const first = residual[0]!;
		return err({
			kind: "unresolved_placeholder",
			templateName: template.name,
			placeholder: first.placeholder,
			fieldPath: first.fieldPath,
		});
	}

	if (!Value.Check(PlanDraftSchema, cloned)) {
		const errors = [...Value.Errors(PlanDraftSchema, cloned)];
		const firstError = errors[0];
		const message = firstError ? `${firstError.instancePath}: ${firstError.message}` : "unknown validation error";
		return err({
			kind: "invalid_plan",
			templateName: template.name,
			message,
		});
	}

	return ok({
		plan: cloned as PlanDraftDoc,
		templateName: template.name,
		templateArgs: Object.fromEntries(
			template.parameters.filter((p) => p.name in args).map((p) => [p.name, args[p.name]!]),
		),
	});
};

// ============================================================================
// Internal helpers
// ============================================================================

const SINGLE_PLACEHOLDER_RE = /^\{\{([^}]+)\}\}$/;

const substituteStrings = (obj: unknown, map: ReadonlyMap<string, string>): void => {
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			const val = obj[i];
			if (typeof val === "string") {
				obj[i] = substituteValue(val, map);
			} else if (typeof val === "object" && val !== null) {
				substituteStrings(val, map);
			}
		}
		return;
	}

	if (typeof obj === "object" && obj !== null) {
		const record = obj as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			const val = record[key];
			if (typeof val === "string") {
				record[key] = substituteValue(val, map);
			} else if (typeof val === "object" && val !== null) {
				substituteStrings(val, map);
			}
		}
	}
};

const substituteValue = (str: string, map: ReadonlyMap<string, string>): unknown => {
	const singleMatch = SINGLE_PLACEHOLDER_RE.exec(str);
	if (singleMatch) {
		const value = map.get(singleMatch[1]!);
		if (value !== undefined) return coerce(value);
		return str;
	}
	return str.replace(PLACEHOLDER_RE, (match, name: string) => {
		const value = map.get(name);
		return value !== undefined ? value : match;
	});
};

const coerce = (value: string): unknown => {
	if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
	if (value === "true") return true;
	if (value === "false") return false;
	return value;
};

interface ResidualPlaceholder {
	readonly placeholder: string;
	readonly fieldPath: string;
}

const findResidualPlaceholders = (obj: unknown, path: string): ResidualPlaceholder[] => {
	const results: ResidualPlaceholder[] = [];

	if (typeof obj === "string") {
		PLACEHOLDER_RE.lastIndex = 0;
		let match = PLACEHOLDER_RE.exec(obj);
		while (match !== null) {
			results.push({ placeholder: match[1]!, fieldPath: path || "(root)" });
			match = PLACEHOLDER_RE.exec(obj);
		}
		return results;
	}

	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			results.push(...findResidualPlaceholders(obj[i], `${path}[${i}]`));
		}
		return results;
	}

	if (typeof obj === "object" && obj !== null) {
		for (const [key, val] of Object.entries(obj)) {
			const childPath = path ? `${path}.${key}` : key;
			results.push(...findResidualPlaceholders(val, childPath));
		}
	}

	return results;
};
