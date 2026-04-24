import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArtifactId, StepId } from "../../src/plan/ids.js";
import { runCommand, runFilesExist, tailLines } from "../../src/runtime/checks.js";

const ops = createLocalBashOperations();

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
			type: "files_exist" as const,
			name: StepId("check"),
			paths: [target],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp, ops });
		expect(outcome.type).toBe("pass");
		expect(outcome.exitCode).toBeNull();
	});

	it("passes when a cwd-relative path exists", async () => {
		await writeFile(path.join(tmp, "relative.txt"), "hi");
		const step = {
			type: "files_exist" as const,
			name: StepId("check"),
			paths: ["relative.txt"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp, ops });
		expect(outcome.type).toBe("pass");
	});

	it("fails with a readable reason when the path does not exist", async () => {
		const step = {
			type: "files_exist" as const,
			name: StepId("check"),
			paths: ["no-such-file"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp, ops });
		expect(outcome.type).toBe("fail");
		expect(outcome.reason).toContain("no-such-file");
	});

	it("passes when all paths in an array exist", async () => {
		await writeFile(path.join(tmp, "a.txt"), "a");
		await writeFile(path.join(tmp, "b.txt"), "b");
		const step = {
			type: "files_exist" as const,
			name: StepId("check"),
			paths: ["a.txt", "b.txt"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp, ops });
		expect(outcome.type).toBe("pass");
	});

	it("fails listing the missing paths when some exist and some do not", async () => {
		await writeFile(path.join(tmp, "exists.txt"), "yes");
		const step = {
			type: "files_exist" as const,
			name: StepId("check"),
			paths: ["exists.txt", "missing-a.txt", "missing-b.txt"],
			onSuccess: StepId("ok"),
			onFailure: StepId("bad"),
		};
		const outcome = await runFilesExist(step, { cwd: tmp, ops });
		expect(outcome.type).toBe("fail");
		expect(outcome.reason).toContain("missing-a.txt");
		expect(outcome.reason).toContain("missing-b.txt");
		expect(outcome.reason).not.toContain("exists.txt");
	});
});

describe("runCommand", () => {
	const commandStep = (command: string, timeout?: number) => ({
		type: "command" as const,
		name: StepId("check"),
		command,
		reads: [] as readonly ArtifactId[],
		writes: [] as readonly ArtifactId[],
		timeout,
		onSuccess: StepId("ok"),
		onFailure: StepId("bad"),
	});

	it("passes when the command exits 0", async () => {
		const outcome = await runCommand(commandStep('node -e "process.exit(0)"'), { cwd: process.cwd(), ops });
		expect(outcome.type).toBe("pass");
		expect(outcome.exitCode).toBe(0);
	});

	it("fails with exit code and captures stderr in output", async () => {
		const outcome = await runCommand(commandStep("node -e \"process.stderr.write('boom\\n'); process.exit(3)\""), {
			cwd: process.cwd(),
			ops,
		});
		expect(outcome.type).toBe("fail");
		expect(outcome.exitCode).toBe(3);
		expect(outcome.output).toContain("boom");
		expect(outcome.reason).toContain("code 3");
	});

	it("fails when the command does not exist", async () => {
		const outcome = await runCommand(commandStep("definitely-not-a-real-binary-xyz"), {
			cwd: process.cwd(),
			ops,
		});
		expect(outcome.type).toBe("fail");
		expect(outcome.exitCode).not.toBe(0);
	});

	it("fails with a timeout reason when the command exceeds its timeout", async () => {
		const outcome = await runCommand(commandStep('node -e "setTimeout(() => process.exit(0), 5000)"', 0.2), {
			cwd: process.cwd(),
			ops,
		});
		expect(outcome.type).toBe("fail");
		expect(outcome.reason).toMatch(/timed out/i);
	});

	it("includes output produced before the timeout", async () => {
		const outcome = await runCommand(
			commandStep(
				"node -e \"process.stdout.write('partial progress'); setTimeout(() => process.exit(0), 5000)\"",
				0.2,
			),
			{ cwd: process.cwd(), ops },
		);
		expect(outcome.type).toBe("fail");
		expect(outcome.reason).toMatch(/timed out/i);
		expect(outcome.output).toContain("partial progress");
	});

	it("fails when the abort signal fires mid-run", async () => {
		const ctl = new AbortController();
		const promise = runCommand(commandStep('node -e "setTimeout(() => process.exit(0), 5000)"', 10), {
			cwd: process.cwd(),
			signal: ctl.signal,
			ops,
		});
		setTimeout(() => ctl.abort(), 50);
		const outcome = await promise;
		expect(outcome.type).toBe("fail");
		expect(outcome.reason).toContain("aborted");
	});

	it("includes output produced before abort", async () => {
		const ctl = new AbortController();
		const promise = runCommand(
			commandStep("node -e \"process.stdout.write('working...'); setTimeout(() => process.exit(0), 5000)\"", 10),
			{ cwd: process.cwd(), signal: ctl.signal, ops },
		);
		setTimeout(() => ctl.abort(), 200);
		const outcome = await promise;
		expect(outcome.type).toBe("fail");
		expect(outcome.reason).toContain("aborted");
		expect(outcome.output).toContain("working...");
	});

	it("supports compound shell commands", async () => {
		const outcome = await runCommand(commandStep("echo hello && echo world"), { cwd: process.cwd(), ops });
		expect(outcome.type).toBe("pass");
	});

	it("captures output on success", async () => {
		const outcome = await runCommand(commandStep("echo success-marker"), { cwd: process.cwd(), ops });
		expect(outcome.type).toBe("pass");
		expect(outcome.output).toContain("success-marker");
	});

	it("passes env context to the child process", async () => {
		const chunks: string[] = [];
		const outcome = await runCommand(
			commandStep("node -e \"process.stdout.write(process.env.RELAY_INPUT || 'MISSING')\""),
			{ cwd: process.cwd(), env: { ...process.env, RELAY_INPUT: "/tmp/test-input" }, ops },
			(text) => chunks.push(text),
		);
		expect(outcome.type).toBe("pass");
		expect(chunks.join("")).toContain("/tmp/test-input");
	});

	it("preserves standard PATH when complete env with extra vars is set", async () => {
		const outcome = await runCommand(commandStep("node --version"), {
			cwd: process.cwd(),
			env: { ...process.env, RELAY_INPUT: "/tmp/test" },
			ops,
		});
		expect(outcome.type).toBe("pass");
	});

	it("uses getShellEnv fallback when env is not provided", async () => {
		const outcome = await runCommand(commandStep("node --version"), {
			cwd: process.cwd(),
			ops,
		});
		expect(outcome.type).toBe("pass");
	});

	it("uses the provided BashOperations for execution", async () => {
		const calls: string[] = [];
		const mockOps = {
			exec: async (command: string, _cwd: string, _opts: Record<string, unknown>) => {
				calls.push(command);
				return { exitCode: 0 };
			},
		};
		const outcome = await runCommand(commandStep("echo test"), { cwd: process.cwd(), ops: mockOps });
		expect(outcome.type).toBe("pass");
		expect(calls).toEqual(["echo test"]);
	});
});

describe("tailLines", () => {
	it("returns empty string for empty input", () => {
		expect(tailLines("")).toBe("");
		expect(tailLines("   ")).toBe("");
	});

	it("returns all lines when under the limit", () => {
		const input = "line 1\nline 2\nline 3";
		expect(tailLines(input)).toBe("line 1\nline 2\nline 3");
	});

	it("keeps only the last 20 lines when over the limit", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		const result = tailLines(lines.join("\n"));
		expect(result).toContain("… (10 lines omitted)");
		expect(result).toContain("line 11");
		expect(result).toContain("line 30");
		expect(result).not.toContain("line 10\n");
	});

	it("truncates individual lines longer than 256 characters", () => {
		const longLine = "x".repeat(300);
		const result = tailLines(longLine);
		expect(result.length).toBeLessThan(300);
		expect(result).toContain("…");
		expect(result.replace("…", "").length).toBe(256);
	});

	it("handles mixed short and long lines", () => {
		const input = `short line\n${"a".repeat(400)}\nanother short`;
		const result = tailLines(input);
		expect(result).toContain("short line");
		expect(result).toContain("another short");
		const longLine = result.split("\n")[1]!;
		expect(longLine.length).toBeLessThanOrEqual(257);
	});
});
