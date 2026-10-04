import {
  recordThreadConfigurationDelivery,
  readThreadProviderConfiguration,
} from "../../src/services/threads/thread-provider-configuration.js";
import { getThread, getThreadStartupContext, listEvents } from "@bb/db";
import { createThreadRequestSchema } from "@bb/server-contract";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  expireDeferredThreadReservations,
  THREAD_RESERVATION_TTL_MS,
} from "../../src/services/threads/thread-reservations.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function reserve(
  harness: TestAppHarness,
  configurationGeneration?: number,
) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/deferred-thread",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/deferred-thread",
  });
  const response = await harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      providerId: "codex",
      origin: "sdk",
      input: [],
      dispatch: "deferred",
      ...(configurationGeneration === undefined
        ? {}
        : { configurationGeneration }),
      model: "gpt-5.3-codex",
      environment: { type: "reuse", environmentId: environment.id },
    }),
  });
  expect(response.status).toBe(201);
  return { thread: await response.json(), project, environment };
}

describe("deferred first dispatch", () => {
  it("prepares the exact provider session without a model prompt and fences stale generations", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await reserve(harness, 7);
      const stale = await harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 6, timeoutMs: 2000 }),
        },
      );
      expect(stale.status).toBe(409);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toEqual([]);
      const prepared = harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 7, timeoutMs: 2000 }),
        },
      );
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      if (queued.command.type !== "thread.start")
        throw new Error("Expected provider start");
      expect(queued.command.input).toEqual([]);
      expect(queued.command.configurationGeneration).toBe(7);
      const configurationDelivery = {
        status: "delivered" as const,
        threadId: thread.id,
        providerId: "codex",
        providerSessionId: "session-prepared",
        providerInstanceId: "instance-original",
        generation: 7,
        catalogHash: "a".repeat(64),
        sourceTreeHashes: [],
        toolNames: queued.command.dynamicTools.map((tool) => tool.name),
        instructionsDigest: "b".repeat(64),
        deliveredAt: Date.now(),
        providerReadback: {
          tools: {
            status: "unavailable" as const,
            reason: "provider_tool_discovery_not_observed",
          },
          skills: {
            status: "unavailable" as const,
            reason: "provider_skill_readback_unavailable",
          },
          instructions: {
            status: "unavailable" as const,
            reason: "provider_instruction_readback_unavailable",
          },
          nativeInstructions: {
            status: "unavailable" as const,
            reason: "provider_native_instruction_readback_unavailable",
          },
          nativeMcp: {
            status: "unavailable" as const,
            reason: "provider_native_mcp_readback_unavailable",
          },
        },
      };
      await reportQueuedCommandSuccess(
        harness,
        { ...queued, command: queued.command },
        { providerThreadId: "session-prepared", configurationDelivery },
      );
      const response = await prepared;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        configurationGeneration: 7,
        configurationDelivery,
        dispatchReservation: {
          expiresAt: thread.dispatchReservation.expiresAt,
        },
      });
      expect(
        listEvents(harness.db, { threadId: thread.id }).some(
          (event) => event.type === "turn/started",
        ),
      ).toBe(false);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
      const releaseRequest = harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/release`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 7 }),
        },
      );
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === thread.id,
      );
      if (stop.command.type !== "thread.stop")
        throw new Error("Expected exact provider release");
      const duringRelease = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("Race provider release"),
            mode: "auto",
          }),
        },
      );
      expect(duringRelease.status).toBe(409);
      await reportQueuedCommandSuccess(
        harness,
        { ...stop, command: stop.command },
        { providerCheckpointId: null },
      );
      const released = await releaseRequest;
      expect(released.status, await released.clone().text()).toBe(200);
      const release = (await released.json()).configurationRelease;
      expect(release).toMatchObject({
        generation: 7,
        releasedProviderSessionId: "session-prepared",
      });
      const blockedSend = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("Resume old generation"),
            mode: "auto",
          }),
        },
      );
      expect(blockedSend.status).toBe(409);
      const blockedPrepare = await harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 7 }),
        },
      );
      expect(blockedPrepare.status).toBe(409);
      recordThreadConfigurationDelivery(
        harness.db,
        { ...configurationDelivery, deliveredAt: release.releasedAt + 1 },
        {
          threadId: thread.id,
          providerId: "codex",
          providerSessionId: "session-prepared",
        },
      );
      expect(
        readThreadProviderConfiguration(harness.db, thread.id)?.release,
      ).toEqual(release);
      const patch = await harness.app.request(`/api/v1/threads/${thread.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          configurationGeneration: 8,
          releaseProviderSession: true,
        }),
      });
      expect(patch.status, await patch.clone().text()).toBe(200);
      expect((await patch.json()).configurationDelivery.generation).toBe(7);
      const reprepareRequest = harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 8, timeoutMs: 2000 }),
        },
      );
      const reprepare = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.configuration.prepare" &&
          command.threadId === thread.id,
      );
      if (reprepare.command.type !== "thread.configuration.prepare")
        throw new Error("Expected exact existing-session prepare");
      expect(reprepare.command.resumeContext).toMatchObject({
        providerThreadId: "session-prepared",
        configurationGeneration: 8,
      });
      expect(reprepare.command).not.toHaveProperty("input");
      const updatedDelivery = {
        ...configurationDelivery,
        generation: 8,
        providerInstanceId: "instance-renewed",
        deliveredAt: release.releasedAt + 2,
      };
      await reportQueuedCommandSuccess(
        harness,
        { ...reprepare, command: reprepare.command },
        {
          providerThreadId: "session-prepared",
          configurationDelivery: updatedDelivery,
        },
      );
      const reprepared = await reprepareRequest;
      expect(reprepared.status, await reprepared.clone().text()).toBe(200);
      expect(await reprepared.json()).toMatchObject({
        configurationGeneration: 8,
        configurationDelivery: updatedDelivery,
        configurationRelease: null,
      });
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("refuses managed configure failures before provider dispatch and preserves legacy omission", async () => {
    await withTestHarness(async (harness) => {
      const pluginRoot = join(harness.config.dataDir, "configuration-refusal");
      await mkdir(pluginRoot);
      await writeFile(
        join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "bb-plugin-configuration-refusal",
          version: "0.1.0",
          bb: {
            name: "Configuration refusal",
            description: "Checks managed fail-close",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(pluginRoot, "server.ts"),
        `export default function plugin(bb: any) { bb.agents.configure(() => { throw new Error("factory_refusal:configuration_binding_unavailable"); }); }`,
      );
      expect((await harness.pluginService.installPath(pluginRoot)).status).toBe(
        "running",
      );
      const { thread } = await reserve(harness, 7);
      const refused = await harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 7, timeoutMs: 2000 }),
        },
      );
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect(await refused.text()).toContain("agent_configuration_refused");
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
      const legacy = await reserve(harness);
      const response = await harness.app.request(
        `/api/v1/threads/${legacy.thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput(
              "Legacy configure omissions preserve their existing behavior",
            ),
            mode: "auto",
            model: "gpt-5.3-codex",
          }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === legacy.thread.id,
      );
      expect(
        listQueuedThreadCommands(harness, "thread.start", legacy.thread.id),
      ).toHaveLength(1);
    });
  });

  it("returns a bounded preparation timeout without starting a model turn", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await reserve(harness, 3);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/configuration/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configurationGeneration: 3, timeoutMs: 1 }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(504);
      expect(await response.text()).toContain("configuration_prepare_timeout");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("returns the exact thread before any turn or provider start and starts only on a separate send", async () => {
    await withTestHarness(async (harness) => {
      const pluginRoot = join(harness.config.dataDir, "reserved-configure");
      const bindingPath = join(harness.config.dataDir, "host-bindings.json");
      const callsPath = join(harness.config.dataDir, "configure-calls.txt");
      await mkdir(pluginRoot);
      await writeFile(
        join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "bb-plugin-reserved-configure",
          version: "0.1.0",
          bb: {
            name: "Reserved configure",
            description: "Checks the first-turn boundary",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(pluginRoot, "server.ts"),
        `
        import { appendFileSync, readFileSync } from "node:fs";
        export default function plugin(bb: any) {
          bb.agents.configure((context: any) => {
            appendFileSync(${JSON.stringify(callsPath)}, context.thread.id + "\\n");
            const bindings = JSON.parse(readFileSync(${JSON.stringify(bindingPath)}, "utf8"));
            const snapshot = bindings[context.thread.id];
            if (typeof snapshot !== "string") throw new Error("host binding missing");
            return { tools: [], skills: [], instructions: snapshot };
          });
        }
      `,
      );
      expect((await harness.pluginService.installPath(pluginRoot)).status).toBe(
        "running",
      );
      const { thread, project, environment } = await reserve(harness);
      expect(thread.status).toBe("pending");
      expect(thread.dispatchReservation.expiresAt).toBeGreaterThan(Date.now());
      expect(thread.projectId).toBe(project.id);
      expect(thread.environmentId).toBe(environment.id);
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toEqual([]);
      expect(existsSync(callsPath)).toBe(false);
      const snapshot = `host-bound recipient=${thread.id};generation=7;digest=verified`;
      await writeFile(bindingPath, JSON.stringify({ [thread.id]: snapshot }));
      const startup = JSON.parse(
        getThreadStartupContext(harness.db, thread.id)!,
      );
      expect(startup.reservationExpiresAt).toBeGreaterThan(Date.now());
      expect(startup.reservationExpiresAt).toBeLessThanOrEqual(
        Date.now() + THREAD_RESERVATION_TTL_MS,
      );
      const sent = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("The exact host binding is installed; start now."),
            mode: "auto",
            model: "gpt-5.3-codex",
          }),
        },
      );
      expect(sent.status).toBe(200);
      const command = await waitForQueuedCommand(
        harness,
        (queued) => queued.command.type === "thread.start",
      );
      expect(command.command).toMatchObject({
        type: "thread.start",
        threadId: thread.id,
      });
      expect(command.command).toHaveProperty(
        "instructions",
        expect.stringContaining(snapshot),
      );
      expect(readFileSync(callsPath, "utf8")).toBe(thread.id + "\n");
      expect(
        expireDeferredThreadReservations(
          harness.deps,
          startup.reservationExpiresAt + 1,
        ),
      ).toBe(0);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
    });
  });

  it("refuses an expired first send before the sweep and archives only expired pending reservations", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await reserve(harness);
      const startup = JSON.parse(
        getThreadStartupContext(harness.db, thread.id)!,
      );
      expect(
        expireDeferredThreadReservations(
          harness.deps,
          startup.reservationExpiresAt - 1,
        ),
      ).toBe(0);
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValue(startup.reservationExpiresAt);
      try {
        const sent = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: textInput("Too late"),
              mode: "auto",
            }),
          },
        );
        expect(sent.status).toBe(410);
        expect(await sent.text()).toContain("thread_reservation_expired");
      } finally {
        now.mockRestore();
      }
      expect(
        expireDeferredThreadReservations(
          harness.deps,
          startup.reservationExpiresAt,
        ),
      ).toBe(1);
      expect(getThread(harness.db, thread.id)?.archivedAt).not.toBeNull();
      expect(
        expireDeferredThreadReservations(
          harness.deps,
          startup.reservationExpiresAt + 1,
        ),
      ).toBe(0);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toEqual([]);
    });
  });

  it("does not accept hidden initial work or a scheduled initial turn in deferred mode", () => {
    const base = {
      projectId: "p",
      providerId: "codex",
      origin: "sdk",
      dispatch: "deferred",
      input: [],
      environment: { type: "reuse", environmentId: "e" },
    };
    expect(createThreadRequestSchema.safeParse(base).success).toBe(true);
    expect(
      createThreadRequestSchema.safeParse({
        ...base,
        input: textInput("Hidden work"),
      }).success,
    ).toBe(false);
    expect(
      createThreadRequestSchema.safeParse({
        ...base,
        sendAt: Date.now() + 60_000,
      }).success,
    ).toBe(false);
    expect(
      createThreadRequestSchema.safeParse({ ...base, dispatch: "immediate" })
        .success,
    ).toBe(false);
    expect(
      createThreadRequestSchema.safeParse({
        ...base,
        dispatch: undefined,
        input: textInput("Existing caller"),
      }).success,
    ).toBe(true);
  });
});
