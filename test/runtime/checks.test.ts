import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../../src/runtime/checks.js";

describe("runCheck (file_exists)", () => {
	let tmp = "";

	beforeEach(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-checks-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("passes when an absolute path exists", async () => {
		const target = path.join(tmp, "present.txt");
		await writeFile(target, "hello");
		const outcome = await runCheck({ kind: "file_exists", path: target }, { cwd: tmp });
		expect(outcome.kind).toBe("pass");
	});

	it("passes when a cwd-relative path exists", async () => {
		await writeFile(path.join(tmp, "relative.txt"), "hi");
		const outcome = await runCheck({ kind: "file_exists", path: "relative.txt" }, { cwd: tmp });
		expect(outcome.kind).toBe("pass");
	});

	it("fails with a readable reason when the path does not exist", async () => {
		const outcome = await runCheck({ kind: "file_exists", path: "no-such-file" }, { cwd: tmp });
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toContain("no-such-file");
		}
	});
});

describe("runCheck (command_exits_zero)", () => {
	it("passes when the command exits 0", async () => {
		const outcome = await runCheck(
			{ kind: "command_exits_zero", command: "node -e \"process.exit(0)\"" },
			{ cwd: process.cwd() },
		);
		expect(outcome.kind).toBe("pass");
	});

	it("fails when the command exits non-zero and captures stderr in the reason", async () => {
		const outcome = await runCheck(
			{ kind: "command_exits_zero", command: "node -e \"process.stderr.write('boom\\n'); process.exit(3)\"" },
			{ cwd: process.cwd() },
		);
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toContain("code 3");
			expect(outcome.reason).toContain("boom");
		}
	});

	it("fails when the command does not exist (spawn error)", async () => {
		const outcome = await runCheck(
			{ kind: "command_exits_zero", command: "definitely-not-a-real-binary-xyz" },
			{ cwd: process.cwd() },
		);
		expect(outcome.kind).toBe("fail");
	});

	it("fails with a timeout reason when the command exceeds its timeout", async () => {
		const outcome = await runCheck(
			{
				kind: "command_exits_zero",
				command: "node -e \"setTimeout(() => process.exit(0), 5000)\"",
				timeoutMs: 200,
			},
			{ cwd: process.cwd() },
		);
		expect(outcome.kind).toBe("fail");
		if (outcome.kind === "fail") {
			expect(outcome.reason).toMatch(/timed out/i);
		}
	});

	it("fails when the abort signal fires mid-run", async () => {
		const ctl = new AbortController();
		const promise = runCheck(
			{
				kind: "command_exits_zero",
				command: "node -e \"setTimeout(() => process.exit(0), 5000)\"",
				timeoutMs: 10_000,
			},
			{ cwd: process.cwd(), signal: ctl.signal },
		);
		setTimeout(() => ctl.abort(), 50);
		const outcome = await promise;
		expect(outcome.kind).toBe("fail");
	});

	it("supports compound shell commands", async () => {
		const outcome = await runCheck(
			{ kind: "command_exits_zero", command: "echo hello && echo world" },
			{ cwd: process.cwd() },
		);
		expect(outcome.kind).toBe("pass");
	});
});
