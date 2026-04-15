/**
 * Status icon palette.
 *
 * Single source of truth for how step statuses map to glyphs and semantic
 * theme colors. Changing a glyph or color here changes it everywhere in the
 * Relay UI.
 */

import type { StepStatus } from "../runtime/events.js";

export type ThemeColorKey = "success" | "error" | "warning" | "muted" | "dim" | "accent" | "toolTitle" | "toolOutput";

export interface StatusIcon {
	readonly glyph: string;
	readonly color: ThemeColorKey;
}

const ICONS: Record<StepStatus, StatusIcon> = {
	pending: { glyph: "▸", color: "dim" },
	ready: { glyph: "▸", color: "muted" },
	running: { glyph: "⏳", color: "warning" },
	retrying: { glyph: "↻", color: "warning" },
	succeeded: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	skipped: { glyph: "∅", color: "dim" },
};

export const iconFor = (status: StepStatus): StatusIcon => ICONS[status];

export const runIcon = (phase: import("../runtime/events.js").RunPhase): StatusIcon => {
	switch (phase) {
		case "pending":
			return { glyph: "▸", color: "muted" };
		case "running":
			return { glyph: "⏳", color: "warning" };
		case "succeeded":
			return { glyph: "✓", color: "success" };
		case "failed":
			return { glyph: "✗", color: "error" };
		case "aborted":
			return { glyph: "⊘", color: "warning" };
		case "incomplete":
			return { glyph: "◐", color: "warning" };
	}
};
