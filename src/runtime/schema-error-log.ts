/**
 * Append-only log for artifact schema errors.
 *
 * When an actor produces output that fails shape validation, route
 * resolution, or completion parsing, a structured entry is appended
 * to `~/.pi/agent/pi-relay/logs/schema-error.log`. Each entry is a
 * single JSON line with a timestamp, context, and the error detail.
 *
 * The log exists for diagnostics — it lets us observe how often actors
 * produce malformed completions or mismatched artifact values without
 * needing to reproduce the full run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-relay",
  "logs",
  "schema-error.log",
);

interface SchemaErrorEntry {
  readonly timestamp: string;
  readonly kind: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly artifactId?: string;
  readonly shape?: unknown;
  readonly value?: unknown;
  readonly error: string;
}

const ensureLogDir = (): void => {
  const dir = path.dirname(LOG_PATH);
  fs.mkdirSync(dir, { recursive: true });
};

const truncateValue = (value: unknown, maxLen: number): unknown => {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) return "(unserializable)";
  if (serialized.length <= maxLen) return value;
  return `${serialized.slice(0, maxLen)}… (${serialized.length} chars)`;
};

const appendEntry = (entry: SchemaErrorEntry): void => {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(LOG_PATH, line, "utf-8");
  } catch {
    // Logging must never crash the runtime.
  }
};

export const logShapeMismatch = (opts: {
  planId: string;
  stepId: string;
  artifactId: string;
  shape: unknown;
  value: unknown;
  error: string;
}): void => {
  appendEntry({
    timestamp: new Date().toISOString(),
    kind: "shape_mismatch",
    planId: opts.planId,
    stepId: opts.stepId,
    artifactId: opts.artifactId,
    shape: opts.shape,
    value: truncateValue(opts.value, 500),
    error: opts.error,
  });
};

export const logContractViolation = (opts: {
  planId: string;
  stepId: string;
  artifactId: string;
  error: string;
}): void => {
  appendEntry({
    timestamp: new Date().toISOString(),
    kind: "contract_violation",
    planId: opts.planId,
    stepId: opts.stepId,
    artifactId: opts.artifactId,
    error: opts.error,
  });
};

export const logCompletionParseError = (opts: {
  planId: string;
  stepId: string;
  error: string;
  actorOutput?: string;
}): void => {
  appendEntry({
    timestamp: new Date().toISOString(),
    kind: "completion_parse_error",
    planId: opts.planId,
    stepId: opts.stepId,
    error: opts.error,
    value: opts.actorOutput
      ? truncateValue(opts.actorOutput, 1000)
      : undefined,
  });
};

export const logRouteMismatch = (opts: {
  planId: string;
  stepId: string;
  route: string;
  allowedRoutes: readonly string[];
}): void => {
  appendEntry({
    timestamp: new Date().toISOString(),
    kind: "route_mismatch",
    planId: opts.planId,
    stepId: opts.stepId,
    error: `route '${opts.route}' not in allowed routes: ${opts.allowedRoutes.join(", ")}`,
  });
};
