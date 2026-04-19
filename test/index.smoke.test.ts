import { describe, expect, it, vi } from "vitest";
import factory from "../src/index.js";

/**
 * Smoke test for the extension entry.
 *
 * The goal is to confirm the factory registers a tool with the right name
 * and wires renderCall/renderResult functions. We don't exercise the full
 * execute path here — that requires a real pi binary to spawn subprocesses
 * for actors. End-to-end correctness is validated by installing the
 * extension and running pi against the sample actor files.
 */

describe("pi-relay extension entry", () => {
  it("registers relay and replay tools with renderCall and renderResult", () => {
    const registered: Array<{
      name: string;
      hasRenderCall: boolean;
      hasRenderResult: boolean;
    }> = [];

    const stubApi = {
      registerTool(tool: {
        name: string;
        renderCall?: unknown;
        renderResult?: unknown;
        parameters: unknown;
      }) {
        registered.push({
          name: tool.name,
          hasRenderCall: typeof tool.renderCall === "function",
          hasRenderResult: typeof tool.renderResult === "function",
        });
      },
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      setSessionName: vi.fn(),
      getSessionName: vi.fn(),
      setLabel: vi.fn(),
      exec: vi.fn(),
      getActiveTools: vi.fn(),
      getAllTools: vi.fn(),
      setActiveTools: vi.fn(),
      getCommands: vi.fn(),
      setModel: vi.fn(),
      getThinkingLevel: vi.fn(),
      setThinkingLevel: vi.fn(),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      getFlag: vi.fn(),
      events: {} as never,
    };

    factory(stubApi as never);

    expect(registered.length).toBe(2);
    const relay = registered.find((r) => r.name === "relay");
    const replay = registered.find((r) => r.name === "replay");
    expect(relay).toBeDefined();
    expect(relay?.hasRenderCall).toBe(true);
    expect(relay?.hasRenderResult).toBe(true);
    expect(replay).toBeDefined();
    expect(replay?.hasRenderCall).toBe(true);
    expect(replay?.hasRenderResult).toBe(true);
  });

  it("the registered tool has a TypeBox parameter schema", () => {
    let captured: { parameters: unknown } | null = null;
    const stubApi = {
      registerTool(tool: { parameters: unknown }) {
        captured = tool as never;
      },
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      setSessionName: vi.fn(),
      getSessionName: vi.fn(),
      setLabel: vi.fn(),
      exec: vi.fn(),
      getActiveTools: vi.fn(),
      getAllTools: vi.fn(),
      setActiveTools: vi.fn(),
      getCommands: vi.fn(),
      setModel: vi.fn(),
      getThinkingLevel: vi.fn(),
      setThinkingLevel: vi.fn(),
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      getFlag: vi.fn(),
      events: {} as never,
    };
    factory(stubApi as never);
    expect(captured).not.toBeNull();
    // TypeBox schemas are plain objects with a `type: "object"` property at the top.
    expect(
      (captured as unknown as { parameters: { type?: string } }).parameters
        .type,
    ).toBe("object");
  });
});
