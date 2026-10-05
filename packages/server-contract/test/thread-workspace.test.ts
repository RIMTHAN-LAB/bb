import { describe, expect, it } from "vitest";
import { prepareThreadWorkspaceRequestSchema } from "../src/index.js";

const request = {
  reservationExpiresAt: 300_001,
  expectedHostId: "host-exact",
  expectedWorkspacePath: "/workspace/exact",
};

describe("reserved workspace request", () => {
  it("keeps required compare-and-swap expectations without adding a timeout", () => {
    expect(prepareThreadWorkspaceRequestSchema.parse(request)).toEqual(request);
    expect(prepareThreadWorkspaceRequestSchema.parse({ ...request, timeoutMs: 60_000 })).toEqual({ ...request, timeoutMs: 60_000 });
  });

  it.each([
    { ...request, reservationExpiresAt: -1 },
    { ...request, reservationExpiresAt: 1.5 },
    { ...request, reservationExpiresAt: Infinity },
    { ...request, expectedHostId: "" },
    { ...request, expectedHostId: undefined },
    { ...request, expectedWorkspacePath: "relative" },
    { ...request, expectedWorkspacePath: "/workspace/\0invalid" },
    { ...request, expectedWorkspacePath: undefined },
    { ...request, timeoutMs: 0 },
    { ...request, timeoutMs: 60_001 },
    { ...request, configurationGeneration: 0 },
    { ...request, nativeContext: { homePath: "/workspace/home" } },
    { ...request, input: [] },
  ])("refuses missing or invalid expectations and unsupported payload %#", (value) => {
    expect(prepareThreadWorkspaceRequestSchema.safeParse(value).success).toBe(false);
  });
});
