import { getThread, listEvents } from "@bb/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  setPluginHookProvider,
  invokePluginInline,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/thread-start-sender-attribution";

afterEach(() => {
  setPluginHookProvider(undefined);
});

async function seedPendingThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  setPluginHookProvider({
    listHooks: (hook) =>
      hook === "message.dispatch"
        ? [
            {
              pluginId: "limiter",
              handler: () => ({ action: "wait", reason: "held" }) as const,
            },
          ]
        : [],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
  const thread = await createThreadFromRequest(harness.deps, {
    environment: {
      type: "host",
      hostId: host.id,
      workspace: { type: "unmanaged", path: `${WORKSPACE_PATH}-target` },
    },
    input: textInput("Waiting for the first message"),
    origin: "app",
    projectId: project.id,
    providerId: "codex",
    startedOnBehalfOf: null,
  });
  setPluginHookProvider(undefined);
  const pending = getThread(harness.db, thread.id);
  if (pending === null) throw new Error("expected the pending thread");
  expect(pending.status).toBe("pending");
  const sender = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "active",
  });
  return { pending, sender };
}

function startRequest(harness: TestAppHarness, threadId: string) {
  const requested = listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
  expect(requested).toHaveLength(1);
  return JSON.parse(requested[0]!.data) as {
    initiator: string;
    senderThreadId: string | null;
    input: { type: string; text?: string }[];
  };
}

describe("the message that starts a pending thread", () => {
  it("is attributed to the agent thread that sent it", async () => {
    await withTestHarness(async (harness) => {
      const { pending, sender } = await seedPendingThread(
        harness,
        "host-start-attributed",
      );

      const response = await acceptThreadSendRequest(harness.deps, {
        thread: pending,
        payload: {
          input: textInput("Please review the plan"),
          mode: "auto",
          senderThreadId: sender.id,
        },
      });

      expect(response).toMatchObject({ ok: true, delivery: "sent" });
      const request = startRequest(harness, pending.id);
      expect(request.initiator).toBe("agent");
      expect(request.senderThreadId).toBe(sender.id);
      const text = request.input.find((item) => item.type === "text")?.text;
      expect(text).toContain(sender.id);
      expect(text).toContain("Please review the plan");
    });
  });

  it("stays the person's message when no sender thread is named", async () => {
    await withTestHarness(async (harness) => {
      const { pending } = await seedPendingThread(
        harness,
        "host-start-unattributed",
      );

      await acceptThreadSendRequest(harness.deps, {
        thread: pending,
        payload: { input: textInput("Please review the plan"), mode: "auto" },
      });

      const request = startRequest(harness, pending.id);
      expect(request.initiator).toBe("user");
      expect(request.senderThreadId).toBeNull();
      expect(request.input).toEqual(textInput("Please review the plan"));
    });
  });
});
