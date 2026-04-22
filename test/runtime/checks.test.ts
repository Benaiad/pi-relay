import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactId, StepId } from "../../src/plan/ids.js";
import { runCommand, runFilesExist } from "../../src/runtime/checks.js";

describe("runFilesExist", () => {
	let tmp = "";

	beforeEach(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-checks-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("passes when a single absolute path exists", async () => {
		const target = path.join(tmp, "present.txt");
		await writeFile(target, "hello");
		const step = {
			kind: "files_exist" as const,
			id: StepId("check"),
			paths: [target],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp });
		expect(outcome.kind).toBe("pass");
	});

	it("passes when a cwd-relative path exists", async () => {
		await writeFile(path.join(tmp, "relative.txt"), "hi");
		const step = {
			kind: "files_exist" as const,
			id: StepId("check"),
			paths: ["relative.txt"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp });
		expect(outcome.kind).toBe("pass");
	});

	it("fails with a readable reason when the path does not exist", async () => {
		const step = {
			kind: "files_exist" as const,
			id: StepId("check"),
			paths: ["no-such-file"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp });
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toContain("no-such-file");
		}
	});

	it("passes when all paths in an array exist", async () => {
		await writeFile(path.join(tmp, "a.txt"), "a");
		await writeFile(path.join(tmp, "b.txt"), "b");
		const step = {
			kind: "files_exist" as const,
			id: StepId("check"),
			paths: ["a.txt", "b.txt"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp });
		expect(outcome.kind).toBe("pass");
	});

	it("fails listing the missing paths when some exist and some do not", async () => {
		await writeFile(path.join(tmp, "exists.txt"), "yes");
		const step = {
			kind: "files_exist" as const,
			id: StepId("check"),
			paths: ["exists.txt", "missing-a.txt", "missing-b.txt"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp });
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toContain("missing-a.txt");
			expect(outcome.reason).toContain("missing-b.txt");
			expect(outcome.reason).not.toContain("exists.txt");
		}
	});
});

describe("runCommand", () => {
	const commandStep = (command: string, timeoutMs?: number) => ({
		kind: "command" as const,
		id: StepId("check"),
		command,
		reads: [] as readonly ArtifactId[],
		writes: [] as readonly ArtifactId[],
		timeoutMs,
		onSuccess: StepId("ok"),
		onFailure: StepId("bad"),
	});

	it("passes when the command exits 0", async () => {
		const outcome = await runCommand(commandStep('node -e "process.exit(0)"'), { cwd: process.cwd() });
		expect(outcome.kind).toBe("pass");
	});

	it("fails when the command exits non-zero and captures stderr in the reason", async () => {
		const outcome = await runCommand(commandStep("node -e \"process.stderr.write('boom\\n'); process.exit(3)\""), {
			cwd: process.cwd(),
		});
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toContain("code 3");
			expect(outcome.reason).toContain("boom");
		}
	});

	it("fails when the command does not exist (spawn error)", async () => {
		const outcome = await runCommand(commandStep("definitely-not-a-real-binary-xyz"), { cwd: process.cwd() });
		expect(outcome.kind).toBe("fail");
	});

	it("fails with a timeout reason when the command exceeds its timeout", async () => {
		const outcome = await runCommand(commandStep('node -e "setTimeout(() => process.exit(0), 5000)"', 200), {
			cwd: process.cwd(),
		});
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toMatch(/timed out/i);
		}
	});

	it("includes output produced before the timeout in the failure reason", async () => {
		const outcome = await runCommand(
			commandStep(
				"node -e \"process.stdout.write('partial progress'); setTimeout(() => process.exit(0), 5000)\"",
				200,
			),
			{ cwd: process.cwd() },
		);
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toMatch(/timed out/i);
			expect(outcome.reason).toContain("partial progress");
		}
	});

	it("fails when the abort signal fires mid-run", async () => {
		const ctl = new AbortController();
		const promise = runCommand(commandStep('node -e "setTimeout(() => process.exit(0), 5000)"', 10_000), {
			cwd: process.cwd(),
			signal: ctl.signal,
		});
		setTimeout(() => ctl.abort(), 50);
		const outcome = await promise;
		expect(outcome.kind).toBe("fail");
	});

	it("includes output produced before abort in the failure reason", async () => {
		const ctl = new AbortController();
		const promise = runCommand(
			commandStep("node -e \"process.stdout.write('working...'); setTimeout(() => process.exit(0), 5000)\"", 10_000),
			{ cwd: process.cwd(), signal: ctl.signal },
		);
		setTimeout(() => ctl.abort(), 200);
		const outcome = await promise;
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toContain("aborted");
			expect(outcome.reason).toContain("working...");
		}
	});

	it("supports compound shell commands", async () => {
		const outcome = await runCommand(commandStep("echo hello && echo world"), { cwd: process.cwd() });
		expect(outcome.kind).toBe("pass");
	});

	it("passes env context to the child process", async () => {
		const chunks: string[] = [];
		const outcome = await runCommand(
			commandStep("node -e \"process.stdout.write(process.env.RELAY_INPUT || 'MISSING')\""),
			{ cwd: process.cwd(), env: { RELAY_INPUT: "/tmp/test-input" } },
			(text) => chunks.push(text),
		);
		expect(outcome.kind).toBe("pass");
		expect(chunks.join("")).toContain("/tmp/test-input");
	});

	it("preserves standard PATH when custom env is set", async () => {
		const outcome = await runCommand(commandStep("node --version"), {
			cwd: process.cwd(),
			env: { RELAY_INPUT: "/tmp/test" },
		});
		expect(outcome.kind).toBe("pass");
	});
});
