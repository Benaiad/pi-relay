/**
 * Types for the template layer.
 *
 * A plan template is a saved, parameterized relay plan stored as a markdown
 * file with YAML frontmatter. The frontmatter declares identity and
 * parameters; the body is the plan in YAML with `{{param}}` placeholders.
 *
 * Templates are discovered from `~/.pi/agent/relay/plans/` (user scope) and
 * `<cwd>/.pi/relay/plans/` (project scope), mirroring actor discovery.
 */

export type TemplateSource = "user" | "project";

export interface TemplateParameter {
	readonly name: string;
	readonly description: string;
	readonly required: boolean;
}

export interface PlanTemplate {
	readonly name: string;
	readonly description: string;
	readonly parameters: readonly TemplateParameter[];
	/** The YAML-parsed plan body as a plain object. Contains `{{...}}` placeholders. */
	readonly rawPlan: Record<string, unknown>;
	readonly source: TemplateSource;
	readonly filePath: string;
}

export interface TemplateWarning {
	readonly templateName: string;
	readonly message: string;
	readonly filePath: string;
}

export interface TemplateDiscovery {
	readonly templates: readonly PlanTemplate[];
	readonly userDir: string;
	readonly projectDir: string | null;
	readonly warnings: readonly TemplateWarning[];
}
