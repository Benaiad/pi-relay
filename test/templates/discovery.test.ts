import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPlanTemplates } from "../../src/templates/discovery.js";
import { instantiateTemplate } from "../../src/templates/substitute.js";

const VALID_TEMPLATE = `---
name: refactor
description: Rename a symbol across a module.
parameters:
  - name: module
    description: Path to the module.
  - name: old_name
    description: Current name.
  - name: new_name
    description: New name.
---

task: "Rename {{old_name}} to {{new_name}} in {{module}}"
entry_step: rename
artifacts: []
steps:
  - type: action
    name: rename
    actor: worker
    instruction: "Rename {{old_name}} to {{new_name}} in {{module}}"
    reads: []
    writes: []
    routes: { done: success }
  - type: terminal
    name: success
    outcome: success
    summary: Done.
`;

const NO_PARAMS_TEMPLATE = `---
name: lint-all
description: Run the linter on the whole project.
---

task: Run the linter
entry_step: lint
artifacts: []
steps:
  - type: command
    name: lint
    command: npm run lint
    on_success: done
    on_failure: failed
  - type: terminal
    name: done
    outcome: success
    summary: Lint passed.
  - type: terminal
    name: failed
    outcome: failure
    summary: Lint failed.
`;

const MISSING_NAME = `---
description: No name field.
---

task: oops
entry_step: a
artifacts: []
steps:
  - type: terminal
    name: a
    outcome: success
    summary: x
`;

const MISSING_DESCRIPTION = `---
name: no-desc
---

task: oops
entry_step: a
artifacts: []
steps:
  - type: terminal
    name: a
    outcome: success
    summary: x
`;

const BAD_YAML_BODY = `---
name: bad-yaml
description: Body is not valid YAML.
---

task: [unclosed bracket
`;

const DUPLICATE_PARAMS = `---
name: dup-params
description: Has duplicate param names.
parameters:
  - name: x
    description: first
  - name: x
    description: second
---

task: "{{x}}"
entry_step: a
artifacts: []
steps:
  - type: terminal
    name: a
    outcome: success
    summary: done
`;

describe("discoverPlanTemplates", () => {
	let tmp = "";
	let bundledDir = "";
	let userDir = "";
	let projectRoot = "";
	let projectDir = "";

	beforeEach(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-templates-"));
		bundledDir = path.join(tmp, "bundled-plans");
		userDir = path.join(tmp, "user-pi", "agent", "pi-relay", "plans");
		projectRoot = path.join(tmp, "proj");
		projectDir = path.join(projectRoot, ".pi", "pi-relay", "plans");
		await mkdir(bundledDir, { recursive: true });
		await mkdir(userDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("loads a valid template with parameters", async () => {
		await writeFile(path.join(userDir, "refactor.md"), VALID_TEMPLATE);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(1);
		const t = disc.templates[0]!;
		expect(t.name).toBe("refactor");
		expect(t.description).toBe("Rename a symbol across a module.");
		expect(t.parameters).toHaveLength(3);
		expect(t.parameters[0]!.name).toBe("module");
		expect(t.parameters[0]!.default).toBeUndefined();
		expect(t.parameters[2]!.name).toBe("new_name");
		expect(t.parameters[2]!.default).toBeUndefined();
		expect(t.rawPlan.task).toBe("Rename {{old_name}} to {{new_name}} in {{module}}");
		expect(t.source).toBe("user");
		expect(disc.warnings).toHaveLength(0);
	});

	it("loads a template with no parameters", async () => {
		await writeFile(path.join(userDir, "lint-all.md"), NO_PARAMS_TEMPLATE);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(1);
		expect(disc.templates[0]!.parameters).toHaveLength(0);
	});

	it("skips files with missing name and records a warning", async () => {
		await writeFile(path.join(userDir, "bad.md"), MISSING_NAME);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(0);
		expect(disc.warnings).toHaveLength(1);
		expect(disc.warnings[0]!.message).toContain("name");
	});

	it("skips files with missing description and records a warning", async () => {
		await writeFile(path.join(userDir, "bad.md"), MISSING_DESCRIPTION);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(0);
		expect(disc.warnings).toHaveLength(1);
		expect(disc.warnings[0]!.message).toContain("description");
	});

	it("skips files with bad YAML body and records a warning", async () => {
		await writeFile(path.join(userDir, "bad.md"), BAD_YAML_BODY);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(0);
		expect(disc.warnings).toHaveLength(1);
		expect(disc.warnings[0]!.message).toContain("YAML");
	});

	it("skips files with duplicate parameter names", async () => {
		await writeFile(path.join(userDir, "dup.md"), DUPLICATE_PARAMS);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(0);
		expect(disc.warnings).toHaveLength(1);
		expect(disc.warnings[0]!.message).toContain("Duplicate");
	});

	it("project templates shadow user templates of the same name", async () => {
		await writeFile(path.join(userDir, "refactor.md"), VALID_TEMPLATE);
		const projectVersion = VALID_TEMPLATE.replace("Rename a symbol across a module.", "PROJECT override");
		await writeFile(path.join(projectDir, "refactor.md"), projectVersion);
		const disc = discoverPlanTemplates(projectRoot, "both", { userDir });
		expect(disc.templates).toHaveLength(1);
		expect(disc.templates[0]!.description).toBe("PROJECT override");
		expect(disc.templates[0]!.source).toBe("project");
	});

	it("scope=user ignores project templates", async () => {
		await writeFile(path.join(projectDir, "refactor.md"), VALID_TEMPLATE);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir });
		expect(disc.templates).toHaveLength(0);
	});

	it("scope=project ignores user templates", async () => {
		await writeFile(path.join(userDir, "refactor.md"), VALID_TEMPLATE);
		const disc = discoverPlanTemplates(projectRoot, "project", { userDir });
		expect(disc.templates).toHaveLength(0);
	});

	it("returns empty when directories don't exist", () => {
		const disc = discoverPlanTemplates("/does/not/exist", "user", {
			userDir: "/also/not/real",
		});
		expect(disc.templates).toHaveLength(0);
		expect(disc.warnings).toHaveLength(0);
	});

	it("cross-validates actor references against a known set", async () => {
		await writeFile(path.join(userDir, "refactor.md"), VALID_TEMPLATE);
		const actorNames = new Set(["reviewer"]);
		const disc = discoverPlanTemplates(projectRoot, "user", {
			userDir,
			actorNames,
		});
		expect(disc.warnings).toHaveLength(1);
		expect(disc.warnings[0]!.message).toContain('unknown actor "worker"');
	});

	it("skips actor cross-validation for parameterized actor names", async () => {
		const template = VALID_TEMPLATE.replace("actor: worker", "actor: '{{actor_name}}'");
		await writeFile(path.join(userDir, "refactor.md"), template);
		const actorNames = new Set(["reviewer"]);
		const disc = discoverPlanTemplates(projectRoot, "user", {
			userDir,
			actorNames,
		});
		expect(disc.warnings).toHaveLength(0);
	});

	it("loads bundled templates from bundledDir", async () => {
		await writeFile(path.join(bundledDir, "refactor.md"), VALID_TEMPLATE);
		const disc = discoverPlanTemplates(projectRoot, "user", {
			userDir: "/no/user/dir",
			bundledDir,
		});
		expect(disc.templates).toHaveLength(1);
		expect(disc.templates[0]!.name).toBe("refactor");
		expect(disc.templates[0]!.source).toBe("bundled");
	});

	it("user templates shadow bundled templates of the same name", async () => {
		await writeFile(path.join(bundledDir, "refactor.md"), VALID_TEMPLATE);
		const userVersion = VALID_TEMPLATE.replace("Rename a symbol across a module.", "User override");
		await writeFile(path.join(userDir, "refactor.md"), userVersion);
		const disc = discoverPlanTemplates(projectRoot, "user", {
			userDir,
			bundledDir,
		});
		expect(disc.templates).toHaveLength(1);
		expect(disc.templates[0]!.description).toBe("User override");
		expect(disc.templates[0]!.source).toBe("user");
	});

	it("project templates shadow bundled templates of the same name", async () => {
		await writeFile(path.join(bundledDir, "refactor.md"), VALID_TEMPLATE);
		const projectVersion = VALID_TEMPLATE.replace("Rename a symbol across a module.", "Project override");
		await writeFile(path.join(projectDir, "refactor.md"), projectVersion);
		const disc = discoverPlanTemplates(projectRoot, "both", {
			userDir: "/no/user/dir",
			bundledDir,
		});
		expect(disc.templates).toHaveLength(1);
		expect(disc.templates[0]!.description).toBe("Project override");
		expect(disc.templates[0]!.source).toBe("project");
	});

	it("merges all three tiers with correct priority", async () => {
		await writeFile(path.join(bundledDir, "refactor.md"), VALID_TEMPLATE);
		await writeFile(path.join(bundledDir, "lint-all.md"), NO_PARAMS_TEMPLATE);
		const userVersion = VALID_TEMPLATE.replace("Rename a symbol across a module.", "User refactor");
		await writeFile(path.join(userDir, "refactor.md"), userVersion);
		const projectVersion = VALID_TEMPLATE.replace("Rename a symbol across a module.", "Project refactor");
		await writeFile(path.join(projectDir, "refactor.md"), projectVersion);
		const disc = discoverPlanTemplates(projectRoot, "both", {
			userDir,
			bundledDir,
		});
		const byName = new Map(disc.templates.map((t) => [t.name, t]));
		expect(byName.get("refactor")!.description).toBe("Project refactor");
		expect(byName.get("refactor")!.source).toBe("project");
		expect(byName.get("lint-all")!.description).toBe("Run the linter on the whole project.");
		expect(byName.get("lint-all")!.source).toBe("bundled");
	});
});

// ============================================================================
// Bundled plan template validation
// ============================================================================

const BUNDLED_PLANS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "bundled", "plans");

const DUMMY_ARGS: Record<string, Record<string, string>> = {
	"verified-edit": { task: "add a button", verify: "npm test" },
	"bug-fix": { bug: "login fails", verify: "npm test" },
	debate: { topic: "is the sky blue?", position: "yes it is", max_rounds: "3" },
	"reviewed-edit": { task: "refactor auth", criteria: "must pass tests", verify: "npm test" },
	"multi-gate": {
		task: "add feature",
		gate1_name: "lint",
		gate1: "npm run lint",
		gate2_name: "test",
		gate2: "npm test",
		gate3_name: "build",
		gate3: "npm run build",
	},
};

describe("bundled plan templates", () => {
	it("discovers all bundled templates without warnings", () => {
		const disc = discoverPlanTemplates("/nonexistent", "user", {
			bundledDir: BUNDLED_PLANS_DIR,
		});
		expect(disc.warnings).toHaveLength(0);
		expect(disc.templates.length).toBeGreaterThanOrEqual(5);
	});

	it.each([
		"verified-edit",
		"bug-fix",
		"debate",
		"reviewed-edit",
		"multi-gate",
	])("%s instantiates with dummy args and produces a valid plan", (templateName) => {
		const disc = discoverPlanTemplates("/nonexistent", "user", {
			bundledDir: BUNDLED_PLANS_DIR,
		});
		const template = disc.templates.find((t) => t.name === templateName);
		expect(template).toBeDefined();

		const args = DUMMY_ARGS[templateName] ?? {};
		const result = instantiateTemplate(template!, args);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.plan.task).toBeTruthy();
		expect(result.value.plan.steps.length).toBeGreaterThanOrEqual(2);
	});
});
