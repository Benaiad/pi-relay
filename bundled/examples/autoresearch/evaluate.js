/**
 * Evaluation gate — DO NOT MODIFY.
 *
 * Compares result.json to best.json. Exits 0 if the new result is
 * faster (improvement), exits 1 if not. Handles cold start, reverts
 * optimize.js on failure.
 *
 * Side effects on improvement:
 *   - Updates best.json with the new result
 *   - Copies optimize.js → optimize.best.js (checkpoint)
 *   - Appends to results.tsv
 *
 * Side effects on no improvement or incorrect result:
 *   - Restores optimize.js from optimize.best.js
 *   - Appends to results.tsv
 */

const fs = require("fs");

const resultPath = "result.json";
const bestPath = "best.json";
const bestCodePath = "optimize.best.js";
const codePath = "optimize.js";
const logPath = "results.tsv";

if (!fs.existsSync(resultPath)) {
	console.error("No result.json found — did benchmark.js run?");
	process.exit(1);
}

const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));

if (!result.correct) {
	revert("incorrect");
	console.error(`INCORRECT — reverted`);
	process.exit(1);
}

const best = fs.existsSync(bestPath) ? JSON.parse(fs.readFileSync(bestPath, "utf-8")) : { time_ms: Infinity };

if (result.time_ms < best.time_ms) {
	fs.writeFileSync(bestPath, JSON.stringify(result, null, 2));
	fs.copyFileSync(codePath, bestCodePath);
	log("keep", result.time_ms);
	const prev = best.time_ms === Infinity ? "baseline" : `${best.time_ms}ms`;
	console.log(`IMPROVED: ${prev} → ${result.time_ms}ms`);
	process.exit(0);
}

revert("not_improved");
console.log(`NOT IMPROVED: ${result.time_ms}ms >= best ${best.time_ms}ms — reverted`);
process.exit(1);

function revert(reason) {
	if (fs.existsSync(bestCodePath)) {
		fs.copyFileSync(bestCodePath, codePath);
	}
	log(reason, result.time_ms);
}

function log(status, time_ms) {
	if (!fs.existsSync(logPath)) {
		fs.writeFileSync(logPath, "time_ms\tstatus\n");
	}
	fs.appendFileSync(logPath, `${time_ms}\t${status}\n`);
}
