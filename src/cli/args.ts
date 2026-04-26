import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface CliArgs {
	readonly templatePath: string;
	readonly params: Readonly<Record<string, string>>;
	readonly paramsFile?: string;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly actorsDir?: string;
	readonly dryRun: boolean;
	readonly help: boolean;
	readonly diagnostics: readonly CliDiagnostic[];
}

export interface CliDiagnostic {
	readonly type: "warning" | "error";
	readonly message: string;
}

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const parseCliArgs = (args: readonly string[]): CliArgs => {
	let templatePath = "";
	const params: Record<string, string> = {};
	let paramsFile: string | undefined;
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;
	let actorsDir: string | undefined;
	let dryRun = false;
	let help = false;
	const diagnostics: CliDiagnostic[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;

		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--model" && i + 1 < args.length) {
			model = args[++i];
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i]!;
			if (VALID_THINKING_LEVELS.has(level)) {
				thinking = level as ThinkingLevel;
			} else {
				diagnostics.push({
					type: "error",
					message: `Invalid thinking level "${level}". Valid: off, minimal, low, medium, high, xhigh`,
				});
			}
		} else if (arg === "--actors-dir" && i + 1 < args.length) {
			actorsDir = args[++i];
		} else if (arg === "-e" && i + 1 < args.length) {
			const value = args[++i]!;
			if (value.startsWith("@")) {
				paramsFile = value.slice(1);
			} else {
				const eqIndex = value.indexOf("=");
				if (eqIndex === -1) {
					diagnostics.push({
						type: "error",
						message: `Invalid -e value "${value}". Expected key=value or @file.json`,
					});
				} else {
					params[value.slice(0, eqIndex)] = value.slice(eqIndex + 1);
				}
			}
		} else if (arg.startsWith("-")) {
			diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (templatePath === "") {
			templatePath = arg;
		} else {
			diagnostics.push({ type: "error", message: `Unexpected argument: ${arg}` });
		}
	}

	if (!help && templatePath === "") {
		diagnostics.push({ type: "error", message: "Missing template file path" });
	}

	return { templatePath, params, paramsFile, model, thinking, actorsDir, dryRun, help, diagnostics };
};

export const printHelp = (): void => {
	const text = `relay — run a relay plan template headlessly

Usage:
  relay <template.md> [-e key=value]... [-e @file.json] [options]

Options:
  -e key=value              Set a template parameter
  -e @file.json             Load parameters from JSON file
  --dry-run                 Validate and show the compiled plan, then exit
  --model <provider/name>   Default model for actors without model config
  --thinking <level>        Default thinking level (default: off)
  --actors-dir <path>       Directory containing actor .md files
  --help, -h                Show this help

Examples:
  relay plans/verified-edit.md -e task="Fix the bug" -e verify="npm test"
  relay plans/verified-edit.md -e @ci/params.json
  relay plans/verified-edit.md -e task="Fix it" --model anthropic/claude-sonnet-4-5 --dry-run
`;
	process.stdout.write(text);
};
