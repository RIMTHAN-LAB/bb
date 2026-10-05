import { describe, expect, it, vi } from "vitest";
import { collectLogPayloads, runCommand, setupCommandOutputTestEnvironment, stubServerApi } from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { makeThread } from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb reserved workspace preparation", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) => registerThreadCommands(program, () => "http://server");

  it("sends only immutable reservation and placement expectations and returns the real response", async () => {
    const result = { ...makeThread({ id: "thread-reserved", projectId: "project-exact", providerId: "codex", status: "pending" }), environmentId: "env-exact", dispatchReservation: { expiresAt: 300_001 } };
    const post = vi.fn(async () => result);
    stubServerApi({ "v1.threads.:id.workspace.prepare.$post": post });
    await runCommand(["thread", "prepare-workspace", "thread-reserved", "--reservation-expires-at", "300001", "--expected-host", "host-exact", "--expected-workspace", "/workspace/exact", "--timeout-ms", "2000", "--json"], register);
    expect(post).toHaveBeenCalledExactlyOnceWith({ param: { id: "thread-reserved" }, json: { reservationExpiresAt: 300_001, expectedHostId: "host-exact", expectedWorkspacePath: "/workspace/exact", timeoutMs: 2000 } });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([JSON.stringify(result, null, 2)]);
  });

  it("rejects an unbounded timeout before calling the server", async () => {
    const post = vi.fn();
    stubServerApi({ "v1.threads.:id.workspace.prepare.$post": post });
    await expect(runCommand(["thread", "prepare-workspace", "thread-reserved", "--reservation-expires-at", "300001", "--expected-host", "host-exact", "--expected-workspace", "/workspace/exact", "--timeout-ms", "60001"], register)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
