/**
 * Append-only audit log.
 *
 * The scheduler emits every state change to the audit log before delivering
 * it to subscribers. `AuditLog.entries()` returns a readonly snapshot of the
 * events in emission order. Replaying the log through `applyEvent` must
 * produce the same final `RelayRunState` as the live scheduler — a property
 * enforced by `audit-replay.test.ts`.
 *
 * The log is in-memory only. Durable storage is a v0.2 feature.
 */

import type { RelayEvent } from "./events.js";

export class AuditLog {
	private readonly events: RelayEvent[] = [];

	append(event: RelayEvent): void {
		this.events.push(event);
	}

	entries(): readonly RelayEvent[] {
		return this.events;
	}

	length(): number {
		return this.events.length;
	}

	clear(): void {
		this.events.length = 0;
	}
}
