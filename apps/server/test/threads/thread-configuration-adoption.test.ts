import { randomUUID } from "node:crypto";
import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threadDispatchReservations,
  threads,
} from "@bb/db";
import {
  threadScope,
  turnScope,
  type NativeContext,
  type ThreadConfigurationDelivery,
} from "@bb/domain";
import {
  threadResponseSchema,
  type ReleaseThreadConfigurationRequest,
  type ThreadResponse,
} from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  readThreadConfigurationDelivery,
  readThreadProviderConfiguration,
} from "../../src/services/threads/thread-provider-configuration.js";
import {
  expireDeferredThreadReservations,
  readThreadAdoptionReservation,
  THREAD_RESERVATION_TTL_MS,
} from "../../src/services/threads/thread-reservations.js";
import {
  stopThreadForCurrentState,
  finalizeStoppedThread,
} from "../../src/services/threads/thread-lifecycle.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEvent,
  seedQueuedMessage,
  seedThreadFixture,
  seedThread,
  seedThreadRuntimeState,
  seedHostSession,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  withTestHarness as withBaseHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { configuredAcpProvider } from "../helpers/provider-registry.js";

async function withTestHarness(
  run: (harness: TestAppHarness) => Promise<void>,
) {
  return withBaseHarness(
    {
      extraProviders: [
        await configuredAcpProvider({
          id: "hermes",
          displayName: "Hermes",
          command: "hermes",
          args: ["acp"],
        }),
      ],
    },
    run,
  );
}

function legacy(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, {
    thread: { providerId: "acp-hermes" },
  });
  const providerSessionId = `native-${randomUUID()}`;
  seedThreadRuntimeState(harness.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: providerSessionId,
  });
  return { ...fixture, providerSessionId };
}

function releaseRequest(
  harness: TestAppHarness,
  id: string,
  body: ReleaseThreadConfigurationRequest,
) {
  return Promise.resolve(
    harness.app.request(`/api/v1/threads/${id}/configuration/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function acknowledgeRelease(harness: TestAppHarness, id: string) {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command }) => command.type === "thread.stop" && command.threadId === id,
  );
  if (queued.command.type !== "thread.stop") throw new Error("Expected stop");
  expect(queued.command.intent).toBe("release");
  await reportQueuedCommandSuccess(
    harness,
    { ...queued, command: queued.command },
    { providerCheckpointId: null },
  );
}

async function responseThread(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return threadResponseSchema.parse(await response.json());
}

function adoption(thread: ThreadResponse) {
  const reservation = thread.dispatchReservation;
  if (reservation == null || !("purpose" in reservation))
    throw new Error("Expected adoption reservation");
  return reservation;
}

async function reserveLegacy(
  harness: TestAppHarness,
  fixture: ReturnType<typeof legacy>,
) {
  const response = releaseRequest(harness, fixture.thread.id, {
    configurationGeneration: null,
    expectedProviderSessionId: fixture.providerSessionId,
  });
  await acknowledgeRelease(harness, fixture.thread.id);
  const thread = await responseThread(await response);
  expect(thread.providerSessionId).toBe(fixture.providerSessionId);
  expect(adoption(thread).expiresAt - adoption(thread).stoppedAt).toBe(
    THREAD_RESERVATION_TTL_MS,
  );
  return thread;
}

async function patch(
  harness: TestAppHarness,
  id: string,
  attemptId: string,
  generation: number,
  nativeContext: NativeContext,
) {
  return harness.app.request(`/api/v1/threads/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      configurationGeneration: generation,
      nativeContext,
      adoptionAttemptId: attemptId,
    }),
  });
}

function delivery(
  id: string,
  providerSessionId: string,
  generation: number,
  nativeContext: NativeContext,
): ThreadConfigurationDelivery {
  const unavailable = {
    status: "unavailable" as const,
    reason: "scripted-test-host",
  };
  return {
    status: "delivered",
    threadId: id,
    providerId: "acp-hermes",
    providerSessionId,
    providerInstanceId: randomUUID(),
    generation,
    nativeContext,
    catalogHash: "a".repeat(64),
    sourceTreeHashes: [],
    toolNames: [],
    instructionsDigest: "b".repeat(64),
    deliveredAt: Date.now(),
    providerReadback: {
      tools: unavailable,
      instructions: unavailable,
      nativeInstructions: unavailable,
      skills: unavailable,
      nativeMcp: unavailable,
    },
  };
}

function prepareRequest(
  harness: TestAppHarness,
  id: string,
  attemptId: string,
  generation: number,
) {
  return Promise.resolve(
    harness.app.request(`/api/v1/threads/${id}/configuration/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        configurationGeneration: generation,
        adoptionAttemptId: attemptId,
        timeoutMs: 2000,
      }),
    }),
  );
}

async function shown(harness: TestAppHarness, id: string) {
  return responseThread(await harness.app.request(`/api/v1/threads/${id}`));
}

describe("legacy configuration adoption", () => {
  it("refuses an active assigned child without touching its provider or the parent", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const child = seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: fixture.environment.id,
        parentThreadId: fixture.thread.id,
        status: "active",
      });
      const before = listEvents(harness.db, { threadId: fixture.thread.id });
      const refused = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
      });
      expect(refused.status).toBe(409);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", child.id),
      ).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toEqual([]);
      expect(getThread(harness.db, child.id)?.status).toBe("active");
      expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
        before,
      );
    });
  });
  it("requires a real provider instance before prepared delivery or managed takeover", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const nativeContext = { homePath: "/tmp/instance-native-home" };
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          first.attemptId,
          1,
          nativeContext,
        ),
      );
      const prepared = prepareRequest(
        harness,
        fixture.thread.id,
        first.attemptId,
        1,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.configuration.prepare" &&
          command.threadId === fixture.thread.id,
      );
      if (queued.command.type !== "thread.configuration.prepare")
        throw new Error("Expected prepare");
      const { providerInstanceId, ...withoutInstance } = delivery(
        fixture.thread.id,
        fixture.providerSessionId,
        1,
        nativeContext,
      );
      void providerInstanceId;
      await reportQueuedCommandSuccess(
        harness,
        { ...queued, command: queued.command },
        {
          providerThreadId: fixture.providerSessionId,
          configurationDelivery: withoutInstance,
        },
      );
      expect((await prepared).status).toBe(503);
      expect(
        readThreadConfigurationDelivery(harness.db, fixture.thread.id),
      ).toBeNull();
      expect(adoption(await shown(harness, fixture.thread.id))).toMatchObject({
        attemptId: first.attemptId,
        state: "failed",
      });
      const released = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: 1,
      });
      expect(released.status).toBe(409);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toEqual([]);
      expect(
        readThreadAdoptionReservation(harness.db, fixture.thread.id)?.attemptId,
      ).toBe(first.attemptId);
    });
  });

  it("does not join an incompatible interrupt as release authority after turn settlement", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      seedTurnStarted(harness.deps, {
        threadId: fixture.thread.id,
        environmentId: fixture.environment.id,
        providerThreadId: fixture.providerSessionId,
        turnId: "interrupt-before-adoption",
        sequence: 10,
      });
      const stopping = stopThreadForCurrentState(
        harness.deps,
        getThread(harness.db, fixture.thread.id)!,
        fixture.environment,
      );
      const interrupt = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      if (interrupt.command.type !== "thread.stop")
        throw new Error("Expected interrupt");
      expect(interrupt.command.intent).toBe("interrupt");
      finalizeStoppedThread(harness.deps, { threadId: fixture.thread.id });
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("idle");
      const refused = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
      });
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain("thread_stop_busy");
      expect(
        readThreadAdoptionReservation(harness.db, fixture.thread.id),
      ).toBeNull();
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toHaveLength(1);
      await reportQueuedCommandSuccess(
        harness,
        { ...interrupt, command: interrupt.command },
        { providerCheckpointId: null },
      );
      await stopping;
      await reserveLegacy(harness, fixture);
    });
  });

  it("does not dedupe different host or environment release authorities", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      seedHostSession(harness.deps, { id: "different-host" });
      const first = stopThreadForCurrentState(
        harness.deps,
        fixture.thread,
        fixture.environment,
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      await expect(
        stopThreadForCurrentState(
          harness.deps,
          fixture.thread,
          { id: fixture.environment.id, hostId: "different-host" },
          { requireStopped: true },
        ),
      ).rejects.toMatchObject({ body: { code: "thread_stop_busy" } });
      await expect(
        stopThreadForCurrentState(
          harness.deps,
          fixture.thread,
          { id: "different-environment", hostId: fixture.environment.hostId },
          { requireStopped: true },
        ),
      ).rejects.toMatchObject({ body: { code: "thread_stop_busy" } });
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toHaveLength(1);
      if (stop.command.type !== "thread.stop") throw new Error("Expected stop");
      await reportQueuedCommandSuccess(
        harness,
        { ...stop, command: stop.command },
        { providerCheckpointId: null },
      );
      await first;
    });
  });

  it("does not cold-start an active Goal context mutation during adoption", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      seedEvent(harness.deps, {
        threadId: fixture.thread.id,
        providerThreadId: fixture.providerSessionId,
        sequence: 10,
        scope: threadScope(),
        type: "thread/goal/updated",
        data: {
          objective: "Retained goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      });
      await reserveLegacy(harness, fixture);
      const before = listEvents(harness.db, { threadId: fixture.thread.id });
      const refused = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/goal/clear`,
        { method: "POST" },
      );
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain("configuration_adoption_pending");
      expect(
        listQueuedThreadCommands(
          harness,
          "thread.goal.clear",
          fixture.thread.id,
        ),
      ).toEqual([]);
      expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
        before,
      );
    });
  });

  it("refuses a wrong native pointer and every non-idle initial owner without sending stop", async () => {
    await withTestHarness(async (harness) => {
      for (const status of [
        "idle",
        "error",
        "pending",
        "starting",
        "active",
        "stopping",
      ] as const) {
        const fixture = legacy(harness);
        harness.db
          .update(threads)
          .set({ status })
          .where(eq(threads.id, fixture.thread.id))
          .run();
        const refused = await releaseRequest(harness, fixture.thread.id, {
          configurationGeneration: null,
          expectedProviderSessionId:
            status === "idle" ? "wrong-session" : fixture.providerSessionId,
        });
        expect(refused.status).toBe(409);
        expect(
          readThreadAdoptionReservation(harness.db, fixture.thread.id),
        ).toBeNull();
        expect(
          listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
        ).toEqual([]);
      }
    });
  });

  it("settles failed recovery to idle only after exact successful stop and preserves the native pointer", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      harness.db
        .update(threadDispatchReservations)
        .set({ expiresAt: Date.now() - 1 })
        .where(eq(threadDispatchReservations.threadId, fixture.thread.id))
        .run();
      harness.db
        .update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      const recovered = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: null,
        },
      });
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("error");
      const competing = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: null,
        },
      });
      expect(competing.status).toBe(409);
      if (stop.command.type !== "thread.stop") throw new Error("Expected stop");
      await reportQueuedCommandSuccess(
        harness,
        { ...stop, command: stop.command },
        { providerCheckpointId: null },
      );
      const current = await responseThread(await recovered);
      expect(current.status).toBe("idle");
      expect(current.providerSessionId).toBe(fixture.providerSessionId);
      expect(adoption(current).attemptId).not.toBe(first.attemptId);
    });
  });

  it("keeps unrelated interrupted completion from normalizing an error thread", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      seedTurnStarted(harness.deps, {
        threadId: fixture.thread.id,
        environmentId: fixture.environment.id,
        providerThreadId: fixture.providerSessionId,
        turnId: "old-failed-turn",
        sequence: 10,
      });
      harness.db
        .update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      const result = applyTurnCompletedEvent(harness.deps, {
        type: "turn/completed",
        threadId: fixture.thread.id,
        providerThreadId: fixture.providerSessionId,
        scope: turnScope("old-failed-turn"),
        status: "interrupted",
      });
      expect(result.isRootTurnCompletion).toBe(true);
      expect(result.nextStatus).toBeNull();
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("error");
    });
  });

  it("replays the current lease without another stop or deadline renewal", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = await reserveLegacy(harness, fixture);
      const replay = await responseThread(
        await releaseRequest(harness, fixture.thread.id, {
          configurationGeneration: null,
          expectedProviderSessionId: fixture.providerSessionId,
        }),
      );
      expect(adoption(replay)).toEqual(adoption(first));
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toEqual([]);
      const stale = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: randomUUID(),
          expectedNativeContext: null,
        },
      });
      expect(stale.status).toBe(409);
      expect(await stale.text()).toContain("configuration_adoption_stale");
      expect(adoption(await shown(harness, fixture.thread.id))).toEqual(
        adoption(first),
      );
    });
  });

  it("preserves an expired conversation and recovers only the current CAS attempt", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const events = listEvents(harness.db, { threadId: fixture.thread.id });
      harness.db
        .update(threadDispatchReservations)
        .set({ expiresAt: Date.now() - 1 })
        .where(eq(threadDispatchReservations.threadId, fixture.thread.id))
        .run();
      expect(expireDeferredThreadReservations(harness.deps, Date.now())).toBe(
        1,
      );
      await acknowledgeRelease(harness, fixture.thread.id);
      expect(expireDeferredThreadReservations(harness.deps, Date.now())).toBe(
        0,
      );
      expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
        status: "idle",
        archivedAt: null,
      });
      expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
        events,
      );
      const expired = await shown(harness, fixture.thread.id);
      expect(expired.providerSessionId).toBe(fixture.providerSessionId);
      expect(adoption(expired).state).toBe("expired");
      const blocked = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: textInput("expired"), mode: "auto" }),
        },
      );
      expect(blocked.status).toBe(409);
      expect(await blocked.text()).toContain("configuration_adoption_expired");
      const recovered = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: null,
        },
      });
      await acknowledgeRelease(harness, fixture.thread.id);
      const next = adoption(await responseThread(await recovered));
      expect(next.attemptId).not.toBe(first.attemptId);
      expect(next.providerSessionId).toBe(first.providerSessionId);
      const stale = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: null,
        },
      });
      expect(stale.status).toBe(409);
      expect(adoption(await shown(harness, fixture.thread.id))).toEqual(next);
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toEqual([]);
    });
  });

  it("recovers partially staged configuration without changing the native home or accepting stale generation", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const nativeContext = { homePath: "/tmp/legacy-native-home" };
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          first.attemptId,
          7,
          nativeContext,
        ),
      );
      harness.db
        .update(threadDispatchReservations)
        .set({ expiresAt: Date.now() - 1 })
        .where(eq(threadDispatchReservations.threadId, fixture.thread.id))
        .run();
      const staleNull = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: null,
        },
      });
      expect(staleNull.status).toBe(409);
      const retry = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: 7,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: nativeContext,
        },
      });
      await acknowledgeRelease(harness, fixture.thread.id);
      const next = adoption(await responseThread(await retry));
      const replay = await responseThread(
        await releaseRequest(harness, fixture.thread.id, {
          configurationGeneration: 7,
          expectedProviderSessionId: fixture.providerSessionId,
          recoverAdoption: {
            attemptId: next.attemptId,
            expectedNativeContext: nativeContext,
          },
        }),
      );
      expect(adoption(replay)).toEqual(next);
      expect(
        readThreadAdoptionReservation(harness.db, fixture.thread.id)
          ?.releasedConfiguration,
      ).toEqual({ generation: 7, nativeContext });
      expect(
        (
          await patch(
            harness,
            fixture.thread.id,
            first.attemptId,
            8,
            nativeContext,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await patch(
            harness,
            fixture.thread.id,
            next.attemptId,
            7,
            nativeContext,
          )
        ).status,
      ).toBe(409);
      const moved = await patch(harness, fixture.thread.id, next.attemptId, 8, {
        homePath: "/tmp/other-home",
      });
      expect(moved.status).toBe(409);
      expect(await moved.text()).toContain("native_context_immutable");
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          next.attemptId,
          8,
          nativeContext,
        ),
      );
      expect(
        readThreadConfigurationDelivery(harness.db, fixture.thread.id),
      ).toBeNull();
    });
  });

  it("marks a real prepare failure and admits an explicit bounded retry before lease expiry", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const nativeContext = { homePath: "/tmp/failed-native-home" };
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          first.attemptId,
          1,
          nativeContext,
        ),
      );
      const failed = prepareRequest(
        harness,
        fixture.thread.id,
        first.attemptId,
        1,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.configuration.prepare" &&
          command.threadId === fixture.thread.id,
      );
      await reportQueuedCommandError(harness, queued, {
        errorCode: "native_restore_failed",
        errorMessage: "Scripted provider could not restore",
      });
      expect((await failed).status).toBe(502);
      expect(adoption(await shown(harness, fixture.thread.id))).toMatchObject({
        attemptId: first.attemptId,
        expiresAt: first.expiresAt,
        state: "failed",
      });
      const retry = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: 1,
        expectedProviderSessionId: fixture.providerSessionId,
        recoverAdoption: {
          attemptId: first.attemptId,
          expectedNativeContext: nativeContext,
        },
      });
      await acknowledgeRelease(harness, fixture.thread.id);
      expect(adoption(await responseThread(await retry)).attemptId).not.toBe(
        first.attemptId,
      );
    });
  });

  it("prepares the retained native session without a turn and consumes the hold only on ordinary send", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const nativeContext = { homePath: "/tmp/prepared-native-home" };
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          first.attemptId,
          1,
          nativeContext,
        ),
      );
      const prepared = prepareRequest(
        harness,
        fixture.thread.id,
        first.attemptId,
        1,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.configuration.prepare" &&
          command.threadId === fixture.thread.id,
      );
      if (queued.command.type !== "thread.configuration.prepare")
        throw new Error("Expected prepare");
      expect(queued.command.resumeContext).toMatchObject({
        providerThreadId: fixture.providerSessionId,
        configurationGeneration: 1,
        nativeContext,
      });
      expect(queued.command).not.toHaveProperty("input");
      await reportQueuedCommandSuccess(
        harness,
        { ...queued, command: queued.command },
        {
          providerThreadId: fixture.providerSessionId,
          configurationDelivery: delivery(
            fixture.thread.id,
            fixture.providerSessionId,
            1,
            nativeContext,
          ),
        },
      );
      const ready = await responseThread(await prepared);
      expect(adoption(ready)).toEqual(first);
      expect(
        (
          await patch(
            harness,
            fixture.thread.id,
            first.attemptId,
            2,
            nativeContext,
          )
        ).status,
      ).toBe(409);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", fixture.thread.id),
      ).toEqual([]);
      const clear = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/context/clear`,
        { method: "POST" },
      );
      expect(clear.status).toBe(409);
      const sent = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("First managed input"),
            mode: "auto",
          }),
        },
      );
      expect(sent.status, await sent.clone().text()).toBe(200);
      expect(
        (await shown(harness, fixture.thread.id)).dispatchReservation,
      ).toBeNull();
      expect(
        listQueuedThreadCommands(harness, "turn.submit", fixture.thread.id),
      ).toHaveLength(1);
    });
  });

  it("refuses a replacement native session and cannot qualify its receipt", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const nativeContext = { homePath: "/tmp/wrong-native-home" };
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          first.attemptId,
          1,
          nativeContext,
        ),
      );
      const prepared = prepareRequest(
        harness,
        fixture.thread.id,
        first.attemptId,
        1,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.configuration.prepare" &&
          command.threadId === fixture.thread.id,
      );
      if (queued.command.type !== "thread.configuration.prepare")
        throw new Error("Expected prepare");
      await reportQueuedCommandSuccess(
        harness,
        { ...queued, command: queued.command },
        {
          providerThreadId: "replacement-session",
          configurationDelivery: delivery(
            fixture.thread.id,
            "replacement-session",
            1,
            nativeContext,
          ),
        },
      );
      const failed = await prepared;
      expect(failed.status).toBe(409);
      expect(await failed.text()).toContain(
        "configuration_adoption_session_mismatch",
      );
      expect(
        readThreadConfigurationDelivery(harness.db, fixture.thread.id),
      ).toBeNull();
      expect((await shown(harness, fixture.thread.id)).providerSessionId).toBe(
        fixture.providerSessionId,
      );
      expect(adoption(await shown(harness, fixture.thread.id)).state).toBe(
        "failed",
      );
    });
  });

  it("switches an expired prepared hold to real managed release without fabricating a boundary", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const first = adoption(await reserveLegacy(harness, fixture));
      const nativeContext = { homePath: "/tmp/released-native-home" };
      await responseThread(
        await patch(
          harness,
          fixture.thread.id,
          first.attemptId,
          1,
          nativeContext,
        ),
      );
      const noReceipt = await releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: 1,
      });
      expect(noReceipt.status).toBe(409);
      const prepared = prepareRequest(
        harness,
        fixture.thread.id,
        first.attemptId,
        1,
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.configuration.prepare" &&
          command.threadId === fixture.thread.id,
      );
      if (queued.command.type !== "thread.configuration.prepare")
        throw new Error("Expected prepare");
      await reportQueuedCommandSuccess(
        harness,
        { ...queued, command: queued.command },
        {
          providerThreadId: fixture.providerSessionId,
          configurationDelivery: delivery(
            fixture.thread.id,
            fixture.providerSessionId,
            1,
            nativeContext,
          ),
        },
      );
      await responseThread(await prepared);
      harness.db
        .update(threadDispatchReservations)
        .set({ expiresAt: Date.now() - 1 })
        .where(eq(threadDispatchReservations.threadId, fixture.thread.id))
        .run();
      const released = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: 1,
      });
      await acknowledgeRelease(harness, fixture.thread.id);
      const managed = await responseThread(await released);
      expect(managed.dispatchReservation).toBeNull();
      expect(managed.configurationRelease).toMatchObject({
        generation: 1,
        releasedProviderSessionId: fixture.providerSessionId,
      });
      expect(managed.configurationDelivery?.providerInstanceId).toBeDefined();
      const blocked = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("old generation"),
            mode: "auto",
          }),
        },
      );
      expect(blocked.status).toBe(409);
    });
  });

  it("blocks direct send, queued admission, edit and clear while preserving retained context", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      await reserveLegacy(harness, fixture);
      const events = listEvents(harness.db, { threadId: fixture.thread.id });
      await expect(
        sendThreadMessage(harness.deps, {
          thread: fixture.thread,
          environment: fixture.environment,
          payload: { input: textInput("direct"), mode: "auto" },
          trigger: "user",
        }),
      ).rejects.toMatchObject({
        body: { code: "configuration_reprepare_required" },
      });
      for (const [route, body] of [
        ["queued-messages", { input: textInput("queued") }],
        [
          "edit-message",
          {
            input: textInput("edit"),
            operationId: randomUUID(),
            expectedRequestSequence: 2,
          },
        ],
        ["context/clear", undefined],
        ["send", { input: textInput("/clear"), mode: "auto" }],
      ] as const) {
        const response = await harness.app.request(
          `/api/v1/threads/${fixture.thread.id}/${route}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        expect(response.status, await response.clone().text()).toBe(409);
      }
      expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
        events,
      );
      expect(listQueuedThreadMessages(harness.db, fixture.thread.id)).toEqual(
        [],
      );
      expect(
        listQueuedThreadCommands(harness, "turn.submit", fixture.thread.id),
      ).toEqual([]);
    });
  });

  it.each(["local_agent", "local_bash", "local_workflow"])(
    "refuses idle adoption with active %s work",
    async (taskType) => {
      await withTestHarness(async (harness) => {
        const fixture = legacy(harness);
        seedEvent(harness.deps, {
          threadId: fixture.thread.id,
          providerThreadId: fixture.providerSessionId,
          sequence: 10,
          scope: turnScope("background-turn"),
          type: "item/started",
          data: {
            item: {
              id: "task:live",
              type: "backgroundTask",
              taskType,
              description: "running",
              status: "pending",
              taskStatus: "running",
              skipTranscript: false,
            },
          },
        });
        const refused = await releaseRequest(harness, fixture.thread.id, {
          configurationGeneration: null,
          expectedProviderSessionId: fixture.providerSessionId,
        });
        expect(refused.status).toBe(409);
        expect(await refused.text()).toContain("thread_configuration_busy");
        expect(
          listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
        ).toEqual([]);
        expect(
          readThreadAdoptionReservation(harness.db, fixture.thread.id),
        ).toBeNull();
      });
    },
  );

  it("refuses queued work and catches an owner change during the stop acknowledgement", async () => {
    await withTestHarness(async (harness) => {
      const queuedFixture = legacy(harness);
      seedQueuedMessage(harness.deps, {
        threadId: queuedFixture.thread.id,
        content: textInput("pending"),
      });
      expect(
        (
          await releaseRequest(harness, queuedFixture.thread.id, {
            configurationGeneration: null,
            expectedProviderSessionId: queuedFixture.providerSessionId,
          })
        ).status,
      ).toBe(409);
      const fixture = legacy(harness);
      const request = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
      });
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      const blocked = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: textInput("race"), mode: "auto" }),
        },
      );
      expect(blocked.status).toBe(409);
      const clear = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/context/clear`,
        { method: "POST" },
      );
      expect(clear.status).toBe(409);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, fixture.thread.id))
        .run();
      if (stop.command.type !== "thread.stop") throw new Error("Expected stop");
      await reportQueuedCommandSuccess(
        harness,
        { ...stop, command: stop.command },
        { providerCheckpointId: null },
      );
      expect((await request).status).toBe(409);
      expect(
        readThreadAdoptionReservation(harness.db, fixture.thread.id),
      ).toBeNull();
      expect(
        readThreadProviderConfiguration(harness.db, fixture.thread.id),
      ).toBeNull();
    });
  });

  it("refuses a strict caller joining a best-effort stop and retains the best-effort failure", async () => {
    await withTestHarness(async (harness) => {
      const fixture = legacy(harness);
      const bestEffort = stopThreadForCurrentState(
        harness.deps,
        fixture.thread,
        fixture.environment,
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === fixture.thread.id,
      );
      const strict = releaseRequest(harness, fixture.thread.id, {
        configurationGeneration: null,
        expectedProviderSessionId: fixture.providerSessionId,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(
        listQueuedThreadCommands(harness, "thread.stop", fixture.thread.id),
      ).toHaveLength(1);
      await reportQueuedCommandError(harness, stop, {
        errorCode: "host_unavailable",
        errorMessage: "Scripted transport unavailable",
      });
      await expect(bestEffort).resolves.toBeUndefined();
      const failed = await strict;
      expect(failed.status).toBe(409);
      expect(await failed.text()).toContain("thread_stop_busy");
      expect(
        readThreadAdoptionReservation(harness.db, fixture.thread.id),
      ).toBeNull();
    });
  });
});
