/**
 * Metadata wrapper for entries in accumulated artifacts.
 *
 * When an artifact has `accumulate: true`, each commit appends an
 * `AccumulatedEntry` instead of the raw value. The entry carries
 * attribution metadata the store already has at commit time: who
 * wrote it (step), when, and its position in the sequence.
 *
 * The presentation layer uses this metadata to render attributed
 * history (e.g., "[1] by philosopher (step: argue): ...") instead
 * of anonymous JSON arrays.
 */

import type { StepId } from "../plan/ids.js";

export interface AccumulatedEntry {
	readonly index: number;
	readonly stepId: StepId;
	readonly attempt: number;
	readonly value: unknown;
	readonly committedAt: number;
}

export const isAccumulatedEntryArray = (value: unknown): value is AccumulatedEntry[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	typeof value[0] === "object" &&
	value[0] !== null &&
	"stepId" in value[0] &&
	"index" in value[0];
