/**
 * Status icon palette.
 *
 * Single source of truth for how step statuses and run phases map to glyphs
 * and semantic theme colors. Changing a glyph or color here changes it
 * everywhere in the Relay UI. The vocabulary deliberately overlaps with
 * subagent's `⏳/✓/✗` so Relay looks visually native alongside pi's
 * existing subagent extension.
 */

import type { RunPhase, StepStatus } from "../runtime/events.js";

export type ThemeColorKey =
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "accent"
  | "toolTitle"
  | "toolOutput";

export interface StatusIcon {
  readonly glyph: string;
  readonly color: ThemeColorKey;
}

const STEP_ICONS: Record<StepStatus, StatusIcon> = {
  pending: { glyph: "·", color: "dim" },
  ready: { glyph: "·", color: "muted" },
  running: { glyph: "⏳", color: "warning" },
  retrying: { glyph: "↻", color: "warning" },
  succeeded: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  skipped: { glyph: "—", color: "dim" },
};

const RUN_ICONS: Record<RunPhase, StatusIcon> = {
  pending: { glyph: "·", color: "muted" },
  running: { glyph: "⏳", color: "warning" },
  succeeded: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  aborted: { glyph: "⊘", color: "warning" },
  incomplete: { glyph: "◐", color: "warning" },
};

export const iconFor = (status: StepStatus): StatusIcon => STEP_ICONS[status];

export const runIcon = (phase: RunPhase): StatusIcon => RUN_ICONS[phase];

/** One-word label for a run outcome, used in the header next to the task. */
export const phaseLabel = (phase: RunPhase): string => {
  switch (phase) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "success";
    case "failed":
      return "failure";
    case "aborted":
      return "aborted";
    case "incomplete":
      return "incomplete";
  }
};
