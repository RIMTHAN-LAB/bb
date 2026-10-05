import {
  getEnvironment,
  environments,
  getPreparingEnvironment,
  getThread,
  getThreadStartupContext,
  listEvents,
  reserveEnvironment,
  threadDispatchReservations,
} from "@bb/db";
import {
  threadResponseSchema,
  threadWithIncludesResponseSchema,
  type PrepareThreadWorkspaceRequest,
} from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { threadScope, UNAVAILABLE_PROVIDER_CONFIGURATION_READBACK } from "@bb/domain";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import { advanceEnvironmentProvisioning } from "../../src/services/environments/environment-engine.js";
import { getCurrentHostRuntimeSession } from "../../src/services/hosts/runtime-capability.js";
import { getEnvironmentProvider } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import { prepareProviderEnvironment, resolveProviderOperationContext } from "../../src/services/threads/thread-environment-placement.js";
import { readPendingThreadStartContext } from "../../src/services/threads/dispatch-attempt.js";
import { readThreadConfigurationDelivery, readThreadProviderConfiguration, recordThreadConfigurationDelivery } from "../../src/services/threads/thread-provider-configuration.js";
import { expireDeferredThreadReservations } from "../../src/services/threads/thread-reservations.js";
import { checkoutProviderInputsSchema, installFakeEnvironmentProvider } from "../helpers/environment-provider.js";
import { listQueuedCommands, listQueuedThreadCommands, reportQueuedCommandError, reportQueuedCommandSuccess, waitForQueuedCommand } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedEnvironment, seedEvent, seedHostSession, seedProjectWithSource, seedSession, seedThread, seedThreadRuntimeState } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const workspace = "/tmp/reserved-workspace-proof";

async function reserveOn(harness: TestAppHarness, placement: { hostId: string; projectId: string }, providerId = "codex") {
  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: placement.projectId,
      providerId,
      ...(providerId === "codex" ? { model: "gpt-5.3-codex" } : {}),
      origin: "sdk",
      input: [],
      dispatch: "deferred",
      environment: { type: "host", hostId: placement.hostId, workspace: { type: "unmanaged", path: workspace } },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const thread = threadResponseSchema.parse(await response.json());
  if (thread.dispatchReservation == null || "purpose" in thread.dispatchReservation)
    throw new Error("Expected the ordinary deferred reservation");
  const request: PrepareThreadWorkspaceRequest = {
    reservationExpiresAt: thread.dispatchReservation.expiresAt,
    expectedHostId: placement.hostId,
    expectedWorkspacePath: workspace,
    timeoutMs: 2000,
  };
  return { thread, request };
}

async function reserve(harness: TestAppHarness, providerId = "codex") {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id, path: workspace });
  const reserved = await reserveOn(harness, { hostId: host.id, projectId: project.id }, providerId);
  const provider = installFakeEnvironmentProvider({
    id: "project-checkout",
    pluginId: "environment-project-checkout",
    displayName: "Project checkout",
    requires: { projectCheckout: true },
    inputs: checkoutProviderInputsSchema,
    decide: () => ({ action: "ready", environment: { type: "host", hostId: host.id, path: workspace, ownsPath: false } }),
  });
  return { ...reserved, host, project, provider };
}

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function holdCreations(threadIds: string[]) {
  const record = getEnvironmentProvider("project-checkout");
  if (record === undefined) throw new Error("Expected the checkout provider");
  const original = record.provider.create;
  const gates = new Map(threadIds.map((id) => [id, { started: barrier(), release: barrier() }]));
  const spy = vi.spyOn(record.provider, "create").mockImplementation(async (context) => {
    const gate = gates.get(context.thread.id);
    if (gate === undefined) throw new Error("Unexpected fixture creation owner");
    gate.started.resolve();
    await gate.release.promise;
    return original(context);
  });
  onTestFinished(() => {
    for (const gate of gates.values()) gate.release.resolve();
    spy.mockRestore();
  });
  return (id: string) => {
    const gate = gates.get(id);
    if (gate === undefined) throw new Error("Unknown fixture creation owner");
    return gate;
  };
}

function prepare(harness: TestAppHarness, id: string, request: PrepareThreadWorkspaceRequest) {
  return Promise.resolve(harness.app.request(`/api/v1/threads/${id}/workspace/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }));
}

async function attachment(harness: TestAppHarness) {
  const queued = await waitForQueuedCommand(harness, ({ command }) => command.type === "environment.attach");
  if (queued.command.type !== "environment.attach") throw new Error("Expected workspace attach");
  expect(queued.command.initiator).toBeNull();
  expect(queued.command.setupScriptTimeoutMs).toBeNull();
  return { ...queued, command: queued.command };
}

async function attachSuccess(harness: TestAppHarness, queued: Awaited<ReturnType<typeof attachment>>) {
  await reportQueuedCommandSuccess(harness, queued, {
    path: workspace,
    isGitRepo: false,
    isWorktree: false,
    branchName: null,
    defaultBranch: null,
  });
}

describe("reserved workspace preparation", () => {
  it("attaches the actual host workspace while leaving the first provider turn reserved", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request, provider } = await reserve(harness);
      const before = await harness.app.request(`/api/v1/threads/${thread.id}?include=environment,host`);
      expect(threadWithIncludesResponseSchema.parse(await before.json())).toMatchObject({ status: "pending", environmentId: null, environment: null, host: null, providerSessionId: null });
      const startupBefore = readPendingThreadStartContext(harness.deps, thread.id);
      expect(startupBefore).not.toBeNull();
      const eventsBefore = listEvents(harness.db, { threadId: thread.id });
      const result = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      await attachSuccess(harness, queued);
      const response = await result;
      expect(response.status, await response.clone().text()).toBe(200);
      const shown = threadWithIncludesResponseSchema.parse(await response.json());
      expect(shown).toMatchObject({ id: thread.id, status: "pending", providerSessionId: null, environmentId: queued.command.environmentId, environment: { id: queued.command.environmentId, hostId: host.id, projectId: project.id, path: workspace, status: "ready" }, host: { id: host.id, runtimeSession: { protocolVersion: 204 } }, dispatchReservation: { expiresAt: request.reservationExpiresAt } });
      expect(getPreparingEnvironment(harness.db, thread.id)).toBeNull();
      expect(JSON.parse(getThreadStartupContext(harness.db, thread.id)!)).toEqual({ ...startupBefore, kind: "pending", environmentIntent: { type: "reuse", environmentId: queued.command.environmentId } });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(eventsBefore);
      expect(readThreadProviderConfiguration(harness.db, thread.id)).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
      expect(listQueuedThreadCommands(harness, "turn.submit", thread.id)).toEqual([]);
      const replay = await prepare(harness, thread.id, request);
      expect(replay.status).toBe(200);
      expect(threadWithIncludesResponseSchema.parse(await replay.json()).environmentId).toBe(shown.environmentId);
      expect(provider.contexts).toHaveLength(1);
      expect(listQueuedCommands(harness, "environment.attach")).toEqual([]);
    });
  });

  it("replays a ready workspace after native configuration without erasing session or delivery authority", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request, provider } = await reserve(harness, "acp-hermes-agent");
      const first = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      await attachSuccess(harness, queued);
      expect((await first).status).toBe(200);
      const patched = await harness.app.request(`/api/v1/threads/${thread.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ configurationGeneration: 0, nativeContext: { homePath: "/tmp/native-home" } }) });
      expect(patched.status, await patched.clone().text()).toBe(200);
      seedEvent(harness.deps, { threadId: thread.id, environmentId: queued.command.environmentId, providerThreadId: "prepared-native-session", sequence: 1, type: "thread/identity", scope: threadScope(), data: {} });
      recordThreadConfigurationDelivery(harness.db, {
        status: "delivered",
        threadId: thread.id,
        providerId: thread.providerId,
        providerSessionId: "prepared-native-session",
        providerInstanceId: "prepared-native-instance",
        generation: 0,
        nativeContext: { homePath: "/tmp/native-home" },
        catalogHash: "a".repeat(64),
        sourceTreeHashes: [],
        toolNames: [],
        instructionsDigest: "b".repeat(64),
        deliveredAt: Date.now(),
        providerReadback: UNAVAILABLE_PROVIDER_CONFIGURATION_READBACK,
      }, { threadId: thread.id, providerId: thread.providerId, providerSessionId: "prepared-native-session" });
      const deliveryBefore = readThreadConfigurationDelivery(harness.db, thread.id);
      expect(deliveryBefore).not.toBeNull();
      const before = getThreadStartupContext(harness.db, thread.id);
      const eventsBefore = listEvents(harness.db, { threadId: thread.id });
      const replay = await prepare(harness, thread.id, request);
      expect(replay.status).toBe(200);
      expect(threadWithIncludesResponseSchema.parse(await replay.json())).toMatchObject({ providerSessionId: "prepared-native-session", configurationGeneration: 0, nativeContext: { homePath: "/tmp/native-home" }, dispatchReservation: { expiresAt: request.reservationExpiresAt } });
      expect(getThreadStartupContext(harness.db, thread.id)).toBe(before);
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(eventsBefore);
      expect(readThreadConfigurationDelivery(harness.db, thread.id)).toEqual(deliveryBefore);
      expect(provider.contexts).toHaveLength(1);
      expect(listQueuedCommands(harness, "environment.attach")).toEqual([]);
    });
  });

  it.each(["host", "path", "lease"])("rejects the wrong expected %s before provisioning", async (field) => {
    await withTestHarness(async (harness) => {
      const { thread, request, provider } = await reserve(harness);
      const changed = { ...request, ...(field === "host" ? { expectedHostId: "host-foreign" } : field === "path" ? { expectedWorkspacePath: "/tmp/foreign" } : { reservationExpiresAt: request.reservationExpiresAt + 1 }) };
      const response = await prepare(harness, thread.id, changed);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain(field === "lease" ? "thread_workspace_reservation_stale" : "thread_workspace_placement_mismatch");
      expect(provider.contexts).toHaveLength(0);
      expect(getPreparingEnvironment(harness.db, thread.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
    });
  });

  it("attaches a second recipient to the same ready workspace without creating another environment", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request, provider } = await reserve(harness);
      const first = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      await attachSuccess(harness, queued);
      expect((await first).status).toBe(200);
      const second = await reserveOn(harness, { hostId: host.id, projectId: project.id });
      const environmentBefore = getEnvironment(harness.db, queued.command.environmentId);
      const firstEvents = listEvents(harness.db, { threadId: thread.id });
      const response = await prepare(harness, second.thread.id, second.request);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(threadWithIncludesResponseSchema.parse(await response.json())).toMatchObject({ status: "pending", providerSessionId: null, environmentId: queued.command.environmentId, environment: { status: "ready", path: workspace, hostId: host.id }, dispatchReservation: { expiresAt: second.request.reservationExpiresAt } });
      expect(getEnvironment(harness.db, queued.command.environmentId)).toEqual(environmentBefore);
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(firstEvents);
      expect(provider.contexts).toHaveLength(1);
      expect(listQueuedCommands(harness, "environment.attach")).toEqual([]);
      expect(listQueuedThreadCommands(harness, "thread.start", second.thread.id)).toEqual([]);
    });
  });

  it("completes an engine-issued ready-workspace handoff that appears during creation atomically", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request, provider } = await reserve(harness);
      const gate = holdCreations([thread.id])(thread.id);
      const result = prepare(harness, thread.id, request);
      await gate.started.promise;
      const captured = getPreparingEnvironment(harness.db, thread.id);
      if (captured === null) throw new Error("Expected the original private environment");
      const shared = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: workspace, environmentProviderId: "project-checkout", environmentProviderPluginId: "environment-project-checkout" });
      const sibling = seedThread(harness.deps, { projectId: project.id, environmentId: shared.id });
      seedThreadRuntimeState(harness.deps, { threadId: sibling.id, environmentId: shared.id, providerThreadId: "shared-sibling-native" });
      const siblingBefore = listEvents(harness.db, { threadId: sibling.id });
      gate.release.resolve();
      const response = await result;
      expect(response.status, await response.clone().text()).toBe(200);
      expect(threadWithIncludesResponseSchema.parse(await response.json())).toMatchObject({ environmentId: shared.id, status: "pending", providerSessionId: null, dispatchReservation: { expiresAt: request.reservationExpiresAt } });
      expect(getEnvironment(harness.db, captured.id)).toMatchObject({ ownerThreadId: null, status: "destroyed", teardownStatus: "removed" });
      expect(getEnvironment(harness.db, shared.id)).toMatchObject({ ownerThreadId: null, status: "ready", teardownStatus: null });
      expect(getPreparingEnvironment(harness.db, thread.id)).toBeNull();
      expect(listEvents(harness.db, { threadId: sibling.id })).toEqual(siblingBefore);
      expect(provider.contexts).toHaveLength(1);
      expect(listQueuedCommands(harness, "environment.attach")).toEqual([]);
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
    });
  });

  it("keeps concurrent same-path preparation bounded without cancelling the winning workspace", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request, provider } = await reserve(harness);
      const second = await reserveOn(harness, { hostId: host.id, projectId: project.id });
      const gates = holdCreations([thread.id, second.thread.id]);
      const firstGate = gates(thread.id);
      const secondGate = gates(second.thread.id);
      const first = prepare(harness, thread.id, request);
      const other = prepare(harness, second.thread.id, second.request);
      await Promise.all([firstGate.started.promise, secondGate.started.promise]);
      firstGate.release.resolve();
      const queued = await attachment(harness);
      const winning = getEnvironment(harness.db, queued.command.environmentId);
      secondGate.release.resolve();
      const refused = await other;
      expect(refused.status).toBe(409);
      expect(getEnvironment(harness.db, queued.command.environmentId)).toEqual(winning);
      expect(getThread(harness.db, second.thread.id)?.environmentId).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", second.thread.id)).toEqual([]);
      expect(listQueuedCommands(harness, "environment.attach.cancel")).toEqual([]);
      await attachSuccess(harness, queued);
      expect((await first).status).toBe(200);
      expect(getEnvironment(harness.db, queued.command.environmentId)).toMatchObject({ status: "ready", ownerThreadId: null, teardownStatus: null });
      expect(provider.contexts).toHaveLength(2);
    });
  });

  it("rolls back the engine ownership transfer if final workspace admission refuses", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request } = await reserve(harness);
      const pending = readPendingThreadStartContext(harness.deps, thread.id);
      const record = getEnvironmentProvider("project-checkout");
      const stored = getThreadStartupContext(harness.db, thread.id);
      const session = getCurrentHostRuntimeSession(harness.deps, host.id);
      const current = getThread(harness.db, thread.id);
      if (pending?.environmentIntent.type !== "provider" || record === undefined || stored === null || session === null || current === null)
        throw new Error("Expected the exact pending workspace authority");
      const operation = await resolveProviderOperationContext(harness.deps, current, pending.environmentIntent, record);
      if (operation === null) throw new Error("Expected the existing checkout operation");
      prepareProviderEnvironment(harness.deps, record, operation, { advance: false });
      const source = getPreparingEnvironment(harness.db, thread.id);
      if (source === null) throw new Error("Expected the captured private source");
      const target = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: workspace });
      const refused = barrier();
      await advanceEnvironmentProvisioning(harness.deps, {
        environmentId: source.id,
        creation: { record, context: operation },
        workspacePreparation: {
          owner: { threadId: thread.id, expiresAt: request.reservationExpiresAt, deadlineAt: Date.now() + 2000, startupContext: stored, hostId: host.id, hostSessionId: session.id, workspacePath: workspace },
          attachReady: (tx, bound) => {
            expect(bound.id).toBe(target.id);
            expect(getEnvironment(tx, target.id)?.ownerThreadId).toBe(thread.id);
            refused.resolve();
            throw new ApiError(409, "thread_workspace_reservation_stale", "Fixture final admission refused");
          },
        },
      });
      await refused.promise;
      expect(getEnvironment(harness.db, target.id)).toEqual(target);
      expect(getPreparingEnvironment(harness.db, thread.id)).toMatchObject({ id: source.id, attempt: source.attempt, ownerThreadId: thread.id, status: "error" });
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(getThreadStartupContext(harness.db, thread.id)).toBe(stored);
      expect(listQueuedCommands(harness, "environment.attach")).toEqual([]);
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
    });
  });

  it.each(["stop", "expiry"])("refuses %s before shared-workspace commit without changing the ready target", async (cause) => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request } = await reserve(harness);
      const gate = holdCreations([thread.id])(thread.id);
      const result = prepare(harness, thread.id, request);
      await gate.started.promise;
      const shared = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: workspace });
      if (cause === "stop") expect((await harness.app.request(`/api/v1/threads/${thread.id}/stop`, { method: "POST" })).status).toBe(200);
      else expireDeferredThreadReservations(harness.deps, request.reservationExpiresAt);
      gate.release.resolve();
      expect((await result).status).toBe(409);
      expect(getEnvironment(harness.db, shared.id)).toEqual(shared);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
    });
  });

  it.each(["foreign", "owned"])("refuses an existing %s ready target without transferring or cancelling it", async (kind) => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request, provider } = await reserve(harness);
      const target = seedEnvironment(harness.deps, { hostId: host.id, projectId: project.id, path: workspace, ...(kind === "foreign" ? { environmentProviderId: "foreign-provider", environmentProviderPluginId: "foreign-plugin" } : {}) });
      if (kind === "owned") {
        const owner = seedThread(harness.deps, { projectId: project.id });
        harness.db.update(environments).set({ ownerThreadId: owner.id }).where(eq(environments.id, target.id)).run();
      }
      const before = getEnvironment(harness.db, target.id);
      const response = await prepare(harness, thread.id, request);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("thread_workspace_prepare_unsupported");
      expect(getEnvironment(harness.db, target.id)).toEqual(before);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(provider.contexts).toHaveLength(0);
      expect(listQueuedCommands(harness, "environment.attach.cancel")).toEqual([]);
    });
  });

  it("excludes concurrent preparation, native PATCH and direct input before attachment", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request, provider } = await reserve(harness);
      const result = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      expect((await prepare(harness, thread.id, request)).status).toBe(409);
      const patch = await harness.app.request(`/api/v1/threads/${thread.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ configurationGeneration: 0 }) });
      expect(patch.status).toBe(409);
      const send = await harness.app.request(`/api/v1/threads/${thread.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: textInput("Must remain unsent"), mode: "auto" }) });
      expect(send.status).toBe(409);
      const queuedInput = await harness.app.request(`/api/v1/threads/${thread.id}/queued-messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: textInput("Must remain unqueued") }) });
      expect(queuedInput.status).toBe(409);
      expect(provider.contexts).toHaveLength(1);
      expect(readThreadProviderConfiguration(harness.db, thread.id)).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
      await attachSuccess(harness, queued);
      expect((await result).status).toBe(200);
    });
  });

  it.each(["stop", "archive", "delete", "expiry", "reconnect"])("fences %s against a late workspace result and preserves sibling history", async (cause) => {
    await withTestHarness(async (harness) => {
      const { thread, host, project, request } = await reserve(harness);
      const sibling = seedThread(harness.deps, { projectId: project.id });
      seedThreadRuntimeState(harness.deps, { threadId: sibling.id, environmentId: null, providerThreadId: "sibling-native-session" });
      const siblingBefore = listEvents(harness.db, { threadId: sibling.id });
      const result = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      if (cause === "reconnect") seedSession(harness.deps, host.id);
      else if (cause === "expiry") expireDeferredThreadReservations(harness.deps, request.reservationExpiresAt);
      else {
        const response = await harness.app.request(`/api/v1/threads/${thread.id}${cause === "stop" ? "/stop" : cause === "archive" ? "/archive-all" : ""}`, { method: cause === "delete" ? "DELETE" : "POST", ...(cause === "delete" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
        expect(response.status, await response.clone().text()).toBe(200);
      }
      await attachSuccess(harness, queued);
      expect((await result).status).toBe(409);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
      expect(listQueuedThreadCommands(harness, "turn.submit", thread.id)).toEqual([]);
      expect(listEvents(harness.db, { threadId: sibling.id })).toEqual(siblingBefore);
      expect(getThread(harness.db, sibling.id)?.status).toBe("idle");
    });
  });

  it("rejects expired and consumed leases without workspace effects", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request, provider } = await reserve(harness);
      const expiresAt = Date.now() - 1;
      harness.db.update(threadDispatchReservations).set({ expiresAt }).where(eq(threadDispatchReservations.threadId, thread.id)).run();
      const expired = await prepare(harness, thread.id, { ...request, reservationExpiresAt: expiresAt });
      expect(expired.status).toBe(410);
      harness.db.delete(threadDispatchReservations).where(eq(threadDispatchReservations.threadId, thread.id)).run();
      const consumed = await prepare(harness, thread.id, request);
      expect(consumed.status).toBe(409);
      expect(await consumed.text()).toContain("thread_workspace_reservation_required");
      expect(provider.contexts).toHaveLength(0);
    });
  });

  it("refuses a different preparing row with the same attempt without cancelling it", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request } = await reserve(harness);
      const result = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      const previous = getPreparingEnvironment(harness.db, thread.id);
      if (previous === null) throw new Error("Expected the captured preparing row");
      const replacement = harness.db.transaction((tx) => {
        tx.update(environments).set({ ownerThreadId: null, claimPath: null }).where(eq(environments.id, previous.id)).run();
        return reserveEnvironment(tx, {
          projectId: previous.projectId,
          ownerThreadId: thread.id,
          environmentProviderId: previous.environmentProviderId,
          environmentProviderPluginId: previous.environmentProviderPluginId,
          environmentProviderSelection: previous.environmentProviderSelection,
          environmentProviderInstanceKey: previous.environmentProviderInstanceKey,
          attempt: previous.attempt,
          hostId: previous.hostId,
          status: "creating",
        });
      }, { behavior: "immediate" });
      if (replacement == null) throw new Error("Expected a replacement preparing row");
      expect(replacement.id).not.toBe(previous.id);
      expect(replacement.attempt).toBe(previous.attempt);
      await attachSuccess(harness, queued);
      const response = await result;
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("thread_workspace_reservation_stale");
      expect(getPreparingEnvironment(harness.db, thread.id)).toEqual(replacement);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
      expect(listQueuedThreadCommands(harness, "turn.submit", thread.id)).toEqual([]);
      expect(listQueuedCommands(harness, "environment.attach.cancel")).toEqual([]);
    });
  });

  it("bounds timeout and does not recreate the errored or cancelled environment on replay", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request, provider } = await reserve(harness);
      const result = prepare(harness, thread.id, { ...request, timeoutMs: 1000 });
      const queued = await attachment(harness);
      const response = await result;
      expect(response.status).toBe(504);
      expect(await response.text()).toContain("thread_workspace_prepare_timeout");
      await reportQueuedCommandError(harness, queued, { errorCode: "environment_attach_cancelled", errorMessage: "Stopped exact fixture workspace" });
      const row = getEnvironment(harness.db, queued.command.environmentId);
      expect(row?.ownerThreadId).toBe(thread.id);
      const replay = await prepare(harness, thread.id, request);
      expect(replay.status).toBe(502);
      expect(provider.contexts).toHaveLength(1);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
    });
  });

  it("returns the workspace failure without starting or retrying the provider", async () => {
    await withTestHarness(async (harness) => {
      const { thread, request, provider } = await reserve(harness);
      const result = prepare(harness, thread.id, request);
      const queued = await attachment(harness);
      await reportQueuedCommandError(harness, queued, { errorCode: "fixture_workspace_failed", errorMessage: "Fixture workspace attachment failed" });
      const response = await result;
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("thread_workspace_prepare_failed");
      expect(provider.contexts).toHaveLength(1);
      expect(getThread(harness.db, thread.id)?.environmentId).toBeNull();
      expect(listQueuedThreadCommands(harness, "thread.start", thread.id)).toEqual([]);
      expect(listQueuedThreadCommands(harness, "turn.submit", thread.id)).toEqual([]);
      const replay = await prepare(harness, thread.id, request);
      expect(replay.status).toBe(502);
      expect(provider.contexts).toHaveLength(1);
    });
  });
});
