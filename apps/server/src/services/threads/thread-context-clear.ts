import { createEventId, getThread } from "@bb/db";
import {
  THREAD_CONTEXT_CLEAR_OPERATION,
  threadScope,
  type Environment,
  type Thread,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { appendThreadEvent } from "./thread-events.js";
import {
  stopThreadForCurrentState,
  requireNoThreadConfigurationTransition,
} from "./thread-lifecycle.js";
import { requireThreadAdoptionContextWritable } from "./thread-reservations.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { requireThreadRuntimeCapability } from "../hosts/runtime-capability.js";

export async function clearThreadContext(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    environment: Pick<Environment, "hostId" | "id">;
    thread: Thread;
  },
): Promise<void> {
  requireThreadRuntimeCapability(deps, args.thread.id, args.environment.hostId);
  await withThreadContextClearGuard(args.thread.id, async () => {
    requireNoThreadConfigurationTransition(args.thread.id);
    requireThreadAdoptionContextWritable(deps.db, args.thread.id);
    const thread = getThread(deps.db, args.thread.id);
    if (!thread) {
      throw new ApiError(404, "invalid_request", "Thread not found");
    }
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      throw new ApiError(409, "invalid_request", "Thread is not writable");
    }
    if (thread.status !== "idle" && thread.status !== "error") {
      throw new ApiError(
        409,
        "invalid_request",
        "Context can only be cleared when the thread is idle or failed",
      );
    }
    if (deps.pendingInteractions.hasPendingThreadInteraction(thread.id)) {
      throw new ApiError(
        409,
        "awaiting_user_interaction",
        "Resolve the pending interaction before clearing context",
      );
    }

    await stopThreadForCurrentState(deps, thread, args.environment);
    requireThreadRuntimeCapability(deps, thread.id, args.environment.hostId);
    requireNoThreadConfigurationTransition(thread.id);
    requireThreadAdoptionContextWritable(deps.db, thread.id);
    const releasedThread = getThread(deps.db, thread.id);
    if (
      !releasedThread ||
      (releasedThread.status !== "idle" && releasedThread.status !== "error")
    ) {
      throw new ApiError(
        409,
        "invalid_request",
        "Thread became active while clearing context",
      );
    }

    appendThreadEvent(deps, {
      threadId: releasedThread.id,
      environmentId: releasedThread.environmentId,
      type: "system/operation",
      scope: threadScope(),
      data: {
        operation: THREAD_CONTEXT_CLEAR_OPERATION,
        operationId: createEventId(),
        status: "completed",
        message:
          "Earlier chat is hidden from the active timeline. Durable history and workspace are unchanged.",
      },
    });
    deps.hub.notifyThread(
      releasedThread.id,
      ["history-rewritten", "status-changed"],
      buildThreadStatusChangeMetadata(deps, releasedThread),
    );
  });
  requestQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: args.thread.id,
  });
}
