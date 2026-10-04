import {
  getThread,
  hostDaemonSessions,
  listEvents,
  listQueuedThreadMessages,
  threadDispatchReservations,
  threadProviderConfigurations,
  threads,
  updateHost,
} from "@bb/db";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { threadScope } from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { threadWithIncludesResponseSchema } from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { callHostOnlineRpc } from "../../src/services/hosts/online-rpc.js";
import {
  getCurrentHostRuntimeSession,
  requireHostCommandRuntimeCapability,
} from "../../src/services/hosts/runtime-capability.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import { clearThreadContext } from "../../src/services/threads/thread-context-clear.js";
import { stopThreadForCurrentState } from "../../src/services/threads/thread-lifecycle.js";
import { attemptDispatch } from "../../src/services/threads/dispatch-attempt.js";
import * as commands from "../../src/services/threads/thread-commands.js";
import * as extensionPayloads from "../../src/internal/extension-payloads.js";
import { sendQueuedMessage } from "../../src/services/threads/queued-messages.js";
import { setThreadProviderConfiguration } from "../../src/services/threads/thread-provider-configuration.js";
import {
  listQueuedThreadCommands,
  createTestDaemonEventEnvelope,
  internalAuthHeaders,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedQueuedMessage,
  seedHost,
  seedSession,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { TRANSPORT_TEST_BRIDGE_LAUNCH } from "../helpers/provider-registry.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function protocol(harness: TestAppHarness, sessionId: string, version: number) {
  harness.db
    .update(hostDaemonSessions)
    .set({ protocolVersion: version })
    .where(eq(hostDaemonSessions.id, sessionId))
    .run();
}

function request(
  harness: TestAppHarness,
  path: string,
  method: string,
  body: unknown,
) {
  return harness.app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("authenticated host runtime capability", () => {
  it("rejects cached203 events after ownership transfers during validation", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const other = seedThreadFixture(harness, {
        session: { id: "transferred-host" },
      });
      protocol(harness, fixture.session.id, 203);
      const entered = createDeferredPromise<void>();
      const resume = createDeferredPromise<void>();
      const validate = extensionPayloads.validateExtensionPayloads;
      const spy = vi
        .spyOn(extensionPayloads, "validateExtensionPayloads")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await resume.promise;
          return validate(...args);
        });
      try {
        const before = listEvents(harness.db, { threadId: fixture.thread.id });
        const pending = harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: fixture.host.id }),
          body: JSON.stringify({
            sessionId: fixture.session.id,
            eventGroups: groupHostDaemonEvents([
              createTestDaemonEventEnvelope({
                threadId: fixture.thread.id,
                event: {
                  type: "thread/name/updated",
                  threadId: fixture.thread.id,
                  providerThreadId: "legacy-provider",
                  scope: threadScope(),
                  threadName: "stale owner must not overwrite",
                },
              }),
            ]),
          }),
        });
        await entered.promise;
        harness.db
          .update(threads)
          .set({ environmentId: other.environment.id })
          .where(eq(threads.id, fixture.thread.id))
          .run();
        setThreadProviderConfiguration(harness.deps, fixture.thread.id, {
          configurationGeneration: 0,
        });
        const desired = harness.db
          .select()
          .from(threadProviderConfigurations)
          .all();
        resume.resolve();
        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "thread_not_owned_by_host",
        });
        expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
          before,
        );
        expect(getThread(harness.db, fixture.thread.id)).toMatchObject({
          title: fixture.thread.title,
          environmentId: other.environment.id,
          status: "idle",
        });
        expect(
          harness.db.select().from(threadProviderConfigurations).all(),
        ).toEqual(desired);
      } finally {
        resume.resolve();
        spy.mockRestore();
      }
    });
  });

  it("refuses a203 managed active report without replacing the current204 session", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness, {
        thread: { status: "error" },
      });
      setThreadProviderConfiguration(harness.deps, thread.id, {
        configurationGeneration: 0,
      });
      const before = harness.db.select().from(hostDaemonSessions).all();
      const desired = harness.db
        .select()
        .from(threadProviderConfigurations)
        .all();
      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "legacy-reconnect",
          hostName: "Legacy Host",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/legacy-host",
          localApiPort: 38888,
          protocolVersion: 203,
          activeThreads: [{ threadId: thread.id }],
          loadedEnvironments: [],
        }),
      });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "host_protocol_upgrade_required",
      });
      expect(harness.db.select().from(hostDaemonSessions).all()).toEqual(
        before,
      );
      expect(harness.hub.getDaemonSessionIdForHost(host.id)).toBe(session.id);
      expect(
        harness.db.select().from(threadProviderConfigurations).all(),
      ).toEqual(desired);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
    });
  });

  it("refuses later203 native event reports before append while keeping foreign-thread ownership behavior", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const foreign = seedThreadFixture(harness, {
        session: { id: "foreign-host" },
      });
      setThreadProviderConfiguration(harness.deps, fixture.thread.id, {
        configurationGeneration: 0,
      });
      setThreadProviderConfiguration(harness.deps, foreign.thread.id, {
        configurationGeneration: 0,
      });
      protocol(harness, fixture.session.id, 203);
      const post = (threadId: string) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness, { hostId: fixture.host.id }),
          body: JSON.stringify({
            sessionId: fixture.session.id,
            eventGroups: groupHostDaemonEvents([
              createTestDaemonEventEnvelope({
                threadId,
                event: {
                  type: "thread/name/updated",
                  threadId,
                  providerThreadId: "legacy-provider",
                  scope: threadScope(),
                  threadName: "must not overwrite",
                },
              }),
            ]),
          }),
        });
      const before = listEvents(harness.db, { threadId: fixture.thread.id });
      expect((await post(fixture.thread.id)).status).toBe(409);
      expect(listEvents(harness.db, { threadId: fixture.thread.id })).toEqual(
        before,
      );
      expect(getThread(harness.db, fixture.thread.id)?.title).toBe(
        fixture.thread.title,
      );
      const unrelated = await post(foreign.thread.id);
      expect(unrelated.status, await unrelated.clone().text()).toBe(200);
      expect(await unrelated.json()).toMatchObject({
        rejectedEvents: [
          { reason: "thread_not_owned_by_host", threadId: foreign.thread.id },
        ],
      });
    });
  });

  it("reports only the current online, active, unexpired host session", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);
      updateHost(harness.db, harness.hub, host.id, {
        lastRejectedProtocolVersion: 203,
      });
      const read = async () => {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}?include=host`,
        );
        expect(response.status).toBe(200);
        return threadWithIncludesResponseSchema.parse(await response.json())
          .host;
      };
      expect((await read())?.runtimeSession).toEqual({
        id: session.id,
        protocolVersion: 204,
      });
      const next = seedSession(harness.deps, host.id);
      protocol(harness, next.id, 203);
      expect((await read())?.runtimeSession).toEqual({
        id: next.id,
        protocolVersion: 203,
      });
      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() - 1 })
        .where(eq(hostDaemonSessions.id, next.id))
        .run();
      expect((await read())?.runtimeSession).toBeNull();
      seedHost(harness.deps, { id: "different-host" });
      harness.db
        .update(hostDaemonSessions)
        .set({ leaseExpiresAt: Date.now() + 60_000, hostId: "different-host" })
        .where(eq(hostDaemonSessions.id, next.id))
        .run();
      expect(getCurrentHostRuntimeSession(harness.deps, host.id)).toBeNull();
      harness.hub.unregisterDaemon(next.id);
      expect((await read())?.runtimeSession).toBeNull();
    });
  });

  it("refuses native create, PATCH, prepare and unmanaged adoption on203 before state or stop effects", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const { session, thread, project, environment } = fixture;
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "retained-native-session",
      });
      protocol(harness, session.id, 203);
      const before = {
        threads: harness.db.select().from(threads).all(),
        configuration: harness.db
          .select()
          .from(threadProviderConfigurations)
          .all(),
        reservations: harness.db
          .select()
          .from(threadDispatchReservations)
          .all(),
        events: listEvents(harness.db, { threadId: thread.id }),
      };
      const create = {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        origin: "sdk",
        dispatch: "deferred",
        input: [],
        environment: { type: "reuse", environmentId: environment.id },
      };
      for (const body of [
        { ...create, configurationGeneration: 0 },
        { ...create, nativeContext: { homePath: "/tmp/protected-home" } },
      ]) {
        const response = await request(
          harness,
          "/api/v1/threads",
          "POST",
          body,
        );
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "host_protocol_upgrade_required",
        });
      }
      for (const [path, method, body] of [
        [
          `/api/v1/threads/${thread.id}`,
          "PATCH",
          { configurationGeneration: 0, title: "must not change" },
        ],
        [
          `/api/v1/threads/${thread.id}/configuration/prepare`,
          "POST",
          { configurationGeneration: 0, timeoutMs: 1000 },
        ],
        [
          `/api/v1/threads/${thread.id}/configuration/release`,
          "POST",
          {
            configurationGeneration: null,
            expectedProviderSessionId: "retained-native-session",
          },
        ],
      ] as const) {
        const response = await request(harness, path, method, body);
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "host_protocol_upgrade_required",
        });
      }
      expect(harness.db.select().from(threads).all()).toEqual(before.threads);
      expect(
        harness.db.select().from(threadProviderConfigurations).all(),
      ).toEqual(before.configuration);
      expect(
        harness.db.select().from(threadDispatchReservations).all(),
      ).toEqual(before.reservations);
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
        before.events,
      );
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toEqual([]);
    });
  });

  it("keeps generation0 managed after reconnect and refuses direct and queued input without changing history", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread, environment } = seedThreadFixture(harness);
      setThreadProviderConfiguration(harness.deps, thread.id, {
        configurationGeneration: 0,
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "managed-session",
      });
      const queued = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("queued input"),
      });
      const next = seedSession(harness.deps, host.id);
      protocol(harness, next.id, 203);
      const events = listEvents(harness.db, { threadId: thread.id });
      const queue = listQueuedThreadMessages(harness.db, thread.id);
      await expect(
        sendThreadMessage(harness.deps, {
          thread,
          environment,
          payload: { input: textInput("direct input"), mode: "start" },
          trigger: "user",
        }),
      ).rejects.toMatchObject({
        body: { code: "host_protocol_upgrade_required" },
      });
      await expect(
        sendQueuedMessage(harness.deps, {
          threadId: thread.id,
          queuedMessageId: queued.id,
          mode: "auto",
          claimPolicy: { kind: "explicit-send" },
        }),
      ).rejects.toMatchObject({
        body: { code: "host_protocol_upgrade_required" },
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(events);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual(queue);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it.each(["failed", "expired"] as const)(
    "cannot classify %s adoption history as legacy",
    async (state) => {
      await withTestHarness(async (harness) => {
        const { session, thread, environment } = seedThreadFixture(harness);
        const stoppedAt = Date.now() - 10;
        harness.db
          .insert(threadDispatchReservations)
          .values({
            threadId: thread.id,
            expiresAt: state === "expired" ? stoppedAt : Date.now() + 60_000,
            adoption: JSON.stringify({
              purpose: "configuration-adoption",
              attemptId: "retained-attempt",
              providerSessionId: "retained-native-session",
              stoppedAt,
              state,
              releasedConfiguration: { generation: null, nativeContext: null },
            }),
          })
          .run();
        protocol(harness, session.id, 203);
        const before = harness.db
          .select()
          .from(threadDispatchReservations)
          .all();
        await expect(
          sendThreadMessage(harness.deps, {
            thread,
            environment,
            payload: { input: textInput("must stay fenced"), mode: "start" },
            trigger: "user",
          }),
        ).rejects.toMatchObject({
          body: { code: "host_protocol_upgrade_required" },
        });
        expect(
          harness.db.select().from(threadDispatchReservations).all(),
        ).toEqual(before);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);
      });
    },
  );

  it("refuses native provider options and strict release on the actual203 socket", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread, environment } = seedThreadFixture(harness);
      protocol(harness, session.id, 203);
      const send = vi.spyOn(harness.hub, "recordHostOnlineRpcResponse");
      for (const command of [
        {
          type: "provider.list_models",
          providerId: "codex",
          bridgeLaunch: {
            ...TRANSPORT_TEST_BRIDGE_LAUNCH,
            providerOptions: { acpConfigurationGeneration: 0 },
          },
        },
      ] satisfies HostDaemonRpcCommand[]) {
        await expect(
          callHostOnlineRpc(harness.deps, {
            hostId: host.id,
            command,
            timeoutMs: 100,
          }),
        ).rejects.toMatchObject({
          body: { code: "host_protocol_upgrade_required" },
        });
      }
      await expect(
        stopThreadForCurrentState(harness.deps, thread, environment, {
          requireStopped: true,
        }),
      ).rejects.toMatchObject({
        body: { code: "host_protocol_upgrade_required" },
      });
      expect(send).not.toHaveBeenCalled();
      expect(
        listQueuedThreadCommands(harness, "thread.stop", thread.id),
      ).toEqual([]);
    });
  });

  it("preserves ordinary unmanaged203 context clear and best-effort idle release", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread, environment } = seedThreadFixture(harness);
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "legacy-clear-session",
      });
      protocol(harness, session.id, 203);
      const clear = clearThreadContext(harness.deps, { thread, environment });
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      if (stop.command.type !== "thread.stop")
        throw new Error("Expected idle release");
      expect(stop.command.intent).toBe("release");
      await reportQueuedCommandSuccess(
        harness,
        { ...stop, command: stop.command },
        { providerCheckpointId: null },
      );
      await clear;
      expect(
        harness.db.select().from(threadProviderConfigurations).all(),
      ).toEqual([]);
      expect(
        harness.db.select().from(threadDispatchReservations).all(),
      ).toEqual([]);
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
    });
  });

  it("rechecks the selected socket when204 admission is replaced by203 before send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedThreadFixture(harness);
      const send = harness.hub.requestHostOnlineRpc.bind(harness.hub);
      const spy = vi
        .spyOn(harness.hub, "requestHostOnlineRpc")
        .mockImplementationOnce((args) => {
          const replacement = seedSession(harness.deps, host.id);
          protocol(harness, replacement.id, 203);
          return send(args);
        });
      const command: HostDaemonRpcCommand = {
        type: "provider.list_models",
        providerId: "codex",
        bridgeLaunch: {
          ...TRANSPORT_TEST_BRIDGE_LAUNCH,
          providerOptions: {
            acpNativeContext: { homePath: "/tmp/exact-native-home" },
          },
        },
      };
      await expect(
        callHostOnlineRpc(harness.deps, {
          hostId: host.id,
          command,
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({
        body: { code: "host_protocol_upgrade_required" },
      });
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  it.each(["pending", "idle"] as const)(
    "rechecks %s admission after async preparation before reservation or history mutation",
    async (status) => {
      await withTestHarness(async (harness) => {
        const fixture = seedThreadFixture(harness);
        let thread = fixture.thread;
        if (status === "pending") {
          const created = await request(harness, "/api/v1/threads", "POST", {
            projectId: fixture.project.id,
            providerId: "codex",
            model: "gpt-5",
            origin: "sdk",
            dispatch: "deferred",
            input: [],
            configurationGeneration: 0,
            environment: {
              type: "reuse",
              environmentId: fixture.environment.id,
            },
          });
          expect(created.status, await created.clone().text()).toBe(201);
          const body = await created.json();
          const stored = getThread(harness.db, body.id);
          if (stored === null) throw new Error("Expected reserved thread");
          thread = stored;
        } else {
          setThreadProviderConfiguration(harness.deps, thread.id, {
            configurationGeneration: 0,
          });
          seedThreadRuntimeState(harness.deps, {
            threadId: thread.id,
            environmentId: fixture.environment.id,
            providerThreadId: "retained-session",
          });
        }
        const before = {
          thread: getThread(harness.db, thread.id),
          events: listEvents(harness.db, { threadId: thread.id }),
          reservations: harness.db
            .select()
            .from(threadDispatchReservations)
            .all(),
        };
        const originalExecution = commands.buildExecutionOptions;
        const originalPrepare = commands.prepareTurnSubmitCommandPayload;
        let resolutions = 0;
        const spy =
          status === "pending"
            ? vi
                .spyOn(commands, "buildExecutionOptions")
                .mockImplementation(async (...args) => {
                  const execution = await originalExecution(...args);
                  if (++resolutions === 2)
                    protocol(harness, fixture.session.id, 203);
                  return execution;
                })
            : vi
                .spyOn(commands, "prepareTurnSubmitCommandPayload")
                .mockImplementationOnce(async (...args) => {
                  const prepared = await originalPrepare(...args);
                  protocol(harness, fixture.session.id, 203);
                  return prepared;
                });
        try {
          const payload = {
            input: textInput("admitted before downgrade"),
            mode: "start" as const,
          };
          const sent =
            status === "pending"
              ? attemptDispatch(harness.deps, {
                  thread,
                  payload,
                  source: { kind: "inline" },
                  queuePayload: { kind: "inline" },
                  origin: "sdk",
                  originPluginId: null,
                  startedOnBehalfOf: null,
                  trigger: "user",
                })
              : sendThreadMessage(harness.deps, {
                  thread,
                  environment: fixture.environment,
                  payload,
                  trigger: "user",
                });
          await expect(sent).rejects.toMatchObject({
            body: { code: "host_protocol_upgrade_required" },
          });
        } finally {
          spy.mockRestore();
        }
        expect(getThread(harness.db, thread.id)).toEqual(before.thread);
        expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
          before.events,
        );
        expect(
          harness.db.select().from(threadDispatchReservations).all(),
        ).toEqual(before.reservations);
        expect(
          listQueuedThreadCommands(harness, "thread.start", thread.id),
        ).toEqual([]);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", thread.id),
        ).toEqual([]);
      });
    },
  );

  it("preserves203 unmanaged submit and interrupt without native payload fields", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread, environment } = seedThreadFixture(harness);
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "legacy-session",
      });
      protocol(harness, session.id, 203);
      const sent = sendThreadMessage(harness.deps, {
        thread,
        environment,
        payload: { input: textInput("ordinary legacy input"), mode: "start" },
        trigger: "user",
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      if (queued.command.type !== "turn.submit")
        throw new Error("Expected legacy submit");
      expect(queued.command.resumeContext.providerThreadId).toBe(
        "legacy-session",
      );
      expect(queued.command.resumeContext).not.toHaveProperty("nativeContext");
      expect(queued.command.resumeContext).not.toHaveProperty(
        "configurationGeneration",
      );
      await reportQueuedCommandSuccess(
        harness,
        { ...queued, command: queued.command },
        { appliedAs: "new-turn" },
      );
      await sent;
      requireHostCommandRuntimeCapability(harness.deps, host.id, session.id, {
        type: "thread.stop",
        threadId: thread.id,
        environmentId: environment.id,
        intent: "interrupt",
      });
      expect(
        listEvents(harness.db, { threadId: thread.id }).some(
          (event) => event.type === "client/turn/requested",
        ),
      ).toBe(true);
    });
  });
});
