import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actorRegistryFromDiscovery, discoverActors, formatActorList } from "../../src/actors/discovery.js";
import { ActorId } from "../../src/plan/ids.js";

const ACTOR_WORKER = `---
name: worker
description: Applies code changes to the repo
tools: read, edit, write, bash
model: claude-sonnet-4-6
---

You are a careful coding worker. Implement the task exactly as described.
`;

const ACTOR_SCOUT = `---
name: scout
description: Reconnaissance over a codebase
tools: read, grep, find, ls
---

You are a scout. Report structured findings.
`;

const ACTOR_NO_FRONTMATTER = `# Not an actor

Just a markdown file that should be skipped.
`;

describe("discoverActors", () => {
	let tmp = "";
	let bundledDir = "";
	let userDir = "";
	let projectRoot = "";
	let projectDir = "";

	beforeEach(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-actors-"));
		bundledDir = path.join(tmp, "bundled-actors");
		userDir = path.join(tmp, "user-pi", "agent", "pi-relay", "actors");
		projectRoot = path.join(tmp, "proj");
		projectDir = path.join(projectRoot, ".pi", "pi-relay", "actors");
		await mkdir(bundledDir, { recursive: true });
		await mkdir(userDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("loads actor files with frontmatter", async () => {
		await writeFile(path.join(userDir, "worker.md"), ACTOR_WORKER);
		await writeFile(path.join(userDir, "scout.md"), ACTOR_SCOUT);
		const discovery = discoverActors(projectRoot, "user", { userDir });
		const byName = new Map(discovery.actors.map((a) => [a.name, a]));
		expect(byName.has("worker")).toBe(true);
		expect(byName.has("scout")).toBe(true);
		const worker = byName.get("worker")!;
		expect(worker.description).toBe("Applies code changes to the repo");
		expect(worker.tools).toEqual(["read", "edit", "write", "bash"]);
		expect(worker.model).toBe("claude-sonnet-4-6");
		expect(worker.source).toBe("user");
		expect(worker.systemPrompt).toContain("careful coding worker");
	});

	it("silently skips files without required frontmatter", async () => {
		await writeFile(path.join(userDir, "worker.md"), ACTOR_WORKER);
		await writeFile(path.join(userDir, "bogus.md"), ACTOR_NO_FRONTMATTER);
		const discovery = discoverActors(projectRoot, "user", { userDir });
		expect(discovery.actors.map((a) => a.name)).toEqual(["worker"]);
	});

	it("scope=user ignores project actors", async () => {
		await writeFile(path.join(userDir, "worker.md"), ACTOR_WORKER);
		await writeFile(path.join(projectDir, "scout.md"), ACTOR_SCOUT);
		const discovery = discoverActors(projectRoot, "user", { userDir });
		expect(discovery.actors.map((a) => a.name)).toEqual(["worker"]);
	});

	it("scope=project ignores user actors", async () => {
		await writeFile(path.join(userDir, "worker.md"), ACTOR_WORKER);
		await writeFile(path.join(projectDir, "scout.md"), ACTOR_SCOUT);
		const discovery = discoverActors(projectRoot, "project", { userDir });
		expect(discovery.actors.map((a) => a.name)).toEqual(["scout"]);
		expect(discovery.projectDir).toBe(projectDir);
	});

	it("scope=both merges with project overriding user on name collision", async () => {
		const userWorkerPath = path.join(userDir, "worker.md");
		const projectWorkerPath = path.join(projectDir, "worker.md");
		await writeFile(userWorkerPath, ACTOR_WORKER);
		await writeFile(
			projectWorkerPath,
			`---
name: worker
description: PROJECT override
tools: read
---

Project-specific worker prompt.
`,
		);
		const discovery = discoverActors(projectRoot, "both", { userDir });
		const worker = discovery.actors.find((a) => a.name === "worker")!;
		expect(worker.description).toBe("PROJECT override");
		expect(worker.source).toBe("project");
	});

	it("walks up from a nested cwd to find the nearest project actors dir", async () => {
		await writeFile(path.join(projectDir, "scout.md"), ACTOR_SCOUT);
		const nested = path.join(projectRoot, "a", "b", "c");
		await mkdir(nested, { recursive: true });
		const discovery = discoverActors(nested, "project", { userDir });
		expect(discovery.projectDir).toBe(projectDir);
		expect(discovery.actors.map((a) => a.name)).toEqual(["scout"]);
	});

	it("follows symlinks to actor files", async () => {
		await writeFile(path.join(tmp, "linked.md"), ACTOR_WORKER);
		await symlink(path.join(tmp, "linked.md"), path.join(userDir, "worker.md"));
		const discovery = discoverActors(projectRoot, "user", { userDir });
		expect(discovery.actors.map((a) => a.name)).toEqual(["worker"]);
	});

	it("returns an empty set when no directories exist", () => {
		const discovery = discoverActors("/does/not/exist", "user", {
			userDir: "/also/not/a/real/path",
		});
		expect(discovery.actors).toEqual([]);
	});

	it("formatActorList renders a readable summary", async () => {
		await writeFile(path.join(userDir, "worker.md"), ACTOR_WORKER);
		await writeFile(path.join(userDir, "scout.md"), ACTOR_SCOUT);
		const discovery = discoverActors(projectRoot, "user", { userDir });
		const formatted = formatActorList(discovery.actors);
		expect(formatted).toContain("worker");
		expect(formatted).toContain("scout");
		expect(formatted).toContain("(user)");
	});

	it("loads bundled actors from bundledDir", async () => {
		await writeFile(path.join(bundledDir, "worker.md"), ACTOR_WORKER);
		const discovery = discoverActors(projectRoot, "user", { userDir: "/no/user/dir", bundledDir });
		expect(discovery.actors).toHaveLength(1);
		expect(discovery.actors[0]!.name).toBe("worker");
		expect(discovery.actors[0]!.source).toBe("bundled");
	});

	it("user actors shadow bundled actors of the same name", async () => {
		await writeFile(path.join(bundledDir, "worker.md"), ACTOR_WORKER);
		await writeFile(
			path.join(userDir, "worker.md"),
			`---
name: worker
description: User override
tools: read
---

Custom worker.
`,
		);
		const discovery = discoverActors(projectRoot, "user", { userDir, bundledDir });
		const worker = discovery.actors.find((a) => a.name === "worker")!;
		expect(worker.description).toBe("User override");
		expect(worker.source).toBe("user");
	});

	it("project actors shadow bundled actors of the same name", async () => {
		await writeFile(path.join(bundledDir, "worker.md"), ACTOR_WORKER);
		await writeFile(
			path.join(projectDir, "worker.md"),
			`---
name: worker
description: Project override
tools: read
---

Project worker.
`,
		);
		const discovery = discoverActors(projectRoot, "both", { userDir: "/no/user/dir", bundledDir });
		const worker = discovery.actors.find((a) => a.name === "worker")!;
		expect(worker.description).toBe("Project override");
		expect(worker.source).toBe("project");
	});

	it("merges all three tiers with correct priority", async () => {
		await writeFile(path.join(bundledDir, "worker.md"), ACTOR_WORKER);
		await writeFile(path.join(bundledDir, "scout.md"), ACTOR_SCOUT);
		await writeFile(
			path.join(userDir, "worker.md"),
			`---
name: worker
description: User worker
tools: read
---

User worker prompt.
`,
		);
		await writeFile(
			path.join(projectDir, "worker.md"),
			`---
name: worker
description: Project worker
tools: bash
---

Project worker prompt.
`,
		);
		const discovery = discoverActors(projectRoot, "both", { userDir, bundledDir });
		const byName = new Map(discovery.actors.map((a) => [a.name, a]));
		expect(byName.get("worker")!.description).toBe("Project worker");
		expect(byName.get("worker")!.source).toBe("project");
		expect(byName.get("scout")!.description).toBe("Reconnaissance over a codebase");
		expect(byName.get("scout")!.source).toBe("bundled");
	});
});

describe("actorRegistryFromDiscovery", () => {
	it("adapts a discovery into a compiler-ready registry", () => {
		const registry = actorRegistryFromDiscovery({
			actors: [
				{
					name: "worker",
					description: "d",
					systemPrompt: "",
					source: "user",
					filePath: "/tmp/worker.md",
				},
				{
					name: "scout",
					description: "d",
					systemPrompt: "",
					source: "user",
					filePath: "/tmp/scout.md",
				},
			],
			projectDir: null,
			userDir: "/tmp",
		});
		expect(registry.has(ActorId("worker"))).toBe(true);
		expect(registry.has(ActorId("scout"))).toBe(true);
		expect(registry.has(ActorId("ghost"))).toBe(false);
		expect(registry.names().length).toBe(2);
	});
});
