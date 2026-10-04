import { describe, expect, it } from "vitest";
import {
  prepareThreadConfigurationRequestSchema,
  releaseThreadConfigurationRequestSchema,
  threadDispatchReservationSchema,
  threadResponseSchema,
  updateThreadRequestSchema,
} from "../src/index.js";

const nativeContext = {
  homePath: "/workspace/profiles/retained",
  instructionsConfig: {
    path: "/workspace/profiles/retained/instructions",
    sha256: "a".repeat(64),
  },
};

describe("retained-conversation configuration contract", () => {
  it.each([
    { configurationGeneration: 0 },
    { configurationGeneration: 7 },
    {
      configurationGeneration: null,
      expectedProviderSessionId: "native-retained",
    },
    {
      configurationGeneration: null,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: { attemptId: "attempt-1", expectedNativeContext: null },
    },
    {
      configurationGeneration: 1,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: {
        attemptId: "attempt-1",
        expectedNativeContext: nativeContext,
      },
    },
  ])("retains the exact release arm %#", (request) => {
    expect(releaseThreadConfigurationRequestSchema.parse(request)).toEqual(
      request,
    );
  });

  it.each([
    { configurationGeneration: null },
    {
      configurationGeneration: 1,
      expectedProviderSessionId: "native-retained",
    },
    { configurationGeneration: -1 },
    { configurationGeneration: 1, ignored: true },
    { configurationGeneration: null, expectedProviderSessionId: "" },
    {
      configurationGeneration: null,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: { attemptId: "attempt-1" },
    },
    {
      configurationGeneration: 1,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: { attemptId: "attempt-1", expectedNativeContext: null },
    },
    {
      configurationGeneration: null,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: {
        attemptId: "attempt-1",
        expectedNativeContext: nativeContext,
      },
    },
    {
      configurationGeneration: 1,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: { attemptId: "", expectedNativeContext: nativeContext },
    },
    {
      configurationGeneration: 1,
      expectedProviderSessionId: "native-retained",
      recoverAdoption: {
        attemptId: "attempt-1",
        expectedNativeContext: nativeContext,
        ignored: true,
      },
    },
  ])("refuses incomplete, mixed or ignored release fields %#", (request) => {
    expect(
      releaseThreadConfigurationRequestSchema.safeParse(request).success,
    ).toBe(false);
  });

  it("keeps old deferred reservation bytes and rejects incomplete adoption metadata", () => {
    expect(
      threadDispatchReservationSchema.parse({ expiresAt: 300_001 }),
    ).toEqual({ expiresAt: 300_001 });
    const reservation = {
      purpose: "configuration-adoption",
      attemptId: "attempt-1",
      providerSessionId: "native-retained",
      stoppedAt: 1,
      expiresAt: 300_001,
      state: "reserved",
    };
    for (const state of ["reserved", "failed", "expired"]) {
      expect(
        threadDispatchReservationSchema.parse({ ...reservation, state }),
      ).toEqual({ ...reservation, state });
    }
    expect(
      threadDispatchReservationSchema.safeParse({
        purpose: reservation.purpose,
        expiresAt: 300_001,
      }).success,
    ).toBe(false);
    expect(
      threadDispatchReservationSchema.safeParse({
        ...reservation,
        callerReceipt: true,
      }).success,
    ).toBe(false);
  });

  it("requires explicit native session absence independently of delivery", () => {
    const projection = threadResponseSchema.pick({
      providerSessionId: true,
      dispatchReservation: true,
      configurationGeneration: true,
    });
    expect(projection.parse({ providerSessionId: null })).toEqual({
      providerSessionId: null,
    });
    expect(projection.parse({ providerSessionId: "native-retained" })).toEqual({
      providerSessionId: "native-retained",
    });
    expect(projection.safeParse({}).success).toBe(false);
    expect(projection.safeParse({ providerSessionId: "" }).success).toBe(false);
  });

  it("fences preparation and PATCH by the exact adoption attempt without adding create fields", () => {
    const prepare = {
      configurationGeneration: 1,
      timeoutMs: 60_000,
      adoptionAttemptId: "attempt-1",
    };
    expect(prepareThreadConfigurationRequestSchema.parse(prepare)).toEqual(
      prepare,
    );
    expect(
      prepareThreadConfigurationRequestSchema.safeParse({
        ...prepare,
        timeoutMs: 60_001,
      }).success,
    ).toBe(false);
    expect(
      prepareThreadConfigurationRequestSchema.safeParse({
        ...prepare,
        adoptionAttemptId: "",
      }).success,
    ).toBe(false);
    const update = {
      configurationGeneration: 1,
      nativeContext,
      adoptionAttemptId: "attempt-1",
    };
    expect(updateThreadRequestSchema.parse(update)).toEqual(update);
    expect(
      updateThreadRequestSchema.safeParse({
        title: "metadata",
        adoptionAttemptId: "attempt-1",
      }).success,
    ).toBe(false);
  });
});
