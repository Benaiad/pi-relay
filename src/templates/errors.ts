/**
 * Structured error variants for template instantiation.
 *
 * Each variant carries enough context for a human-readable message.
 * `formatTemplateError` is the single rendering point, matching the
 * pattern of `formatCompileError` in `plan/compile-error-format.ts`.
 */

export type TemplateError =
  | {
      readonly kind: "missing_template";
      readonly name: string;
      readonly available: readonly string[];
    }
  | {
      readonly kind: "missing_required_param";
      readonly templateName: string;
      readonly missing: readonly string[];
      readonly provided: readonly string[];
    }
  | {
      readonly kind: "unresolved_placeholder";
      readonly templateName: string;
      readonly placeholder: string;
      readonly fieldPath: string;
    }
  | {
      readonly kind: "invalid_plan";
      readonly templateName: string;
      readonly message: string;
    };

export const formatTemplateError = (error: TemplateError): string => {
  switch (error.kind) {
    case "missing_template": {
      const list =
        error.available.length > 0
          ? error.available.join(", ")
          : "(none installed)";
      return `Unknown template "${error.name}". Available templates: ${list}`;
    }
    case "missing_required_param": {
      const missing = error.missing.join(", ");
      const provided =
        error.provided.length > 0 ? error.provided.join(", ") : "(none)";
      return `Template "${error.templateName}" requires parameters: ${missing}. Provided: ${provided}`;
    }
    case "unresolved_placeholder":
      return (
        `Template "${error.templateName}" has unresolved placeholder ` +
        `"{{${error.placeholder}}}" at ${error.fieldPath}`
      );
    case "invalid_plan":
      return `Template "${error.templateName}" produced an invalid plan after substitution: ${error.message}`;
  }
};
