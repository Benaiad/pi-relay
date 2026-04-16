import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPlanTemplates } from "../../src/templates/discovery.js";

const VALID_TEMPLATE = `---
name: refactor
description: Rename a symbol across a module.
parameters:
  - name: module
    description: Path to the module.
    required: true
  - name: old_name
    description: Current name.
    required: true
  - name: new_name
    description: New name.
---

task: "Rename {{old_name}} to {{new_name}} in {{module}}"
entryStep: rename
artifacts: []
steps:
  - kind: action
    id: rename
    actor: worker
    instruction: "Rename {{old_name}} to {{new_name}} in {{module}}"
    reads: []
    writes: []
    routes: [{ route: done, to: success }]
  - kind: terminal
    id: success
    outcome: success
    summary: Done.
`;

const NO_PARAMS_TEMPLATE = `---
name: lint-all
description: Run the linter on the whole project.
---

task: Run the linter
entryStep: lint
artifacts: []
steps:
  - kind: check
    id: lint
    check: { kind: command_exits_zero, command: npm, args: [run, lint] }
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: Lint passed.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Lint failed.
`;

const MISSING_NAME = `---
description: No name field.
---

task: oops
entryStep: a
artifacts: []
steps:
  - kind: terminal
    id: a
    outcome: success
    summary: x
`;

const MISSING_DESCRIPTION = `---
name: no-desc
---

task: oops
entryStep: a
artifacts: []
steps:
  - kind: terminal
    id: a
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
entryStep: a
artifacts: []
steps:
  - kind: terminal
    id: a
    outcome: success
    summary: done
`;

describe("discoverPlanTemplates", () => {
	let tmp = "";
	let userDir = "";
	let projectRoot = "";
	let projectDir = "";

	beforeEach(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-templates-"));
		userDir = path.join(tmp, "user-pi", "agent", "relay", "plans");
		projectRoot = path.join(tmp, "proj");
		projectDir = path.join(projectRoot, ".pi", "relay", "plans");
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
		expect(t.parameters[0]!.required).toBe(true);
		expect(t.parameters[2]!.name).toBe("new_name");
		expect(t.parameters[2]!.required).toBe(true);
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
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir, actorNames });
		expect(disc.warnings).toHaveLength(1);
		expect(disc.warnings[0]!.message).toContain('unknown actor "worker"');
	});

	it("skips actor cross-validation for parameterized actor names", async () => {
		const template = VALID_TEMPLATE.replace("actor: worker", "actor: '{{actor_name}}'");
		await writeFile(path.join(userDir, "refactor.md"), template);
		const actorNames = new Set(["reviewer"]);
		const disc = discoverPlanTemplates(projectRoot, "user", { userDir, actorNames });
		expect(disc.warnings).toHaveLength(0);
	});
});
