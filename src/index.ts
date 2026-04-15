/**
 * pi-relay extension entry.
 *
 * Wires the relay tool into pi's extension API. This file stays thin —
 * its only responsibility is registration and choreography. All real
 * logic lives in the modules under src/plan, src/runtime, src/actors,
 * and src/render.
 *
 * NOTE: This is a placeholder pending phase 7. It currently registers
 * nothing.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
	// Phase 7 wires registerTool here.
}
