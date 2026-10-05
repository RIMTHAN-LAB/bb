import {
  getHost,
  getThread,
  getThreadStartupContext,
  getLastStoredProviderThreadId,
  getLastStoredTurnRequestEvent,
  hasQueuedThreadMessages,
  type DbTransaction,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { getCurrentHostRuntimeSession } from "../hosts/runtime-capability.js";
import { readThreadProviderConfiguration } from "./thread-provider-configuration.js";
import { readDispatchReservation } from "./thread-reservations.js";

export interface ThreadWorkspaceOwner {
  threadId: string;
  expiresAt: number;
  deadlineAt: number;
  startupContext: string;
  hostId: string;
  hostSessionId: string;
  workspacePath: string;
}

export function isPristinePendingThreadWorkspace(
  db: LoggedPendingInteractionWorkSessionDeps["db"] | DbTransaction,
  threadId: string,
): boolean {
  const thread = getThread(db, threadId);
  return (
    thread !== null &&
    thread.status === "pending" &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.environmentId === null &&
    getThreadStartupContext(db, threadId) !== null &&
    readThreadProviderConfiguration(db, threadId) === null &&
    getLastStoredProviderThreadId(db, threadId) === null &&
    getLastStoredTurnRequestEvent(db, threadId) === null &&
    !hasQueuedThreadMessages(db, threadId)
  );
}

export function requireThreadWorkspaceOwner(
  deps: LoggedPendingInteractionWorkSessionDeps,
  owner: ThreadWorkspaceOwner,
  db: LoggedPendingInteractionWorkSessionDeps["db"] | DbTransaction = deps.db,
): void {
  const reservation = readDispatchReservation(db, owner.threadId);
  if (reservation === null || "purpose" in reservation)
    throw new ApiError(
      409,
      "thread_workspace_reservation_required",
      "Workspace preparation requires the live ordinary dispatch reservation",
    );
  if (reservation.expiresAt !== owner.expiresAt)
    throw new ApiError(
      409,
      "thread_workspace_reservation_stale",
      "The dispatch reservation changed",
    );
  if (reservation.expiresAt <= Date.now())
    throw new ApiError(410, "thread_reservation_expired", "The deferred thread reservation expired; create a new thread.");
  if (owner.deadlineAt <= Date.now())
    throw new ApiError(504, "thread_workspace_prepare_timeout", "Reserved workspace preparation timed out");
  if (
    !isPristinePendingThreadWorkspace(db, owner.threadId) ||
    getThreadStartupContext(db, owner.threadId) !== owner.startupContext
  )
    throw new ApiError(
      409,
      "thread_workspace_prepare_unsupported",
      "The reserved thread is no longer awaiting its first workspace",
    );
  const host = getHost(db, owner.hostId);
  const session = getCurrentHostRuntimeSession(deps, owner.hostId);
  if (
    host === null ||
    host.phase !== "active" ||
    host.destroyedAt !== null ||
    session?.id !== owner.hostSessionId
  )
    throw new ApiError(
      409,
      "host_runtime_unavailable",
      "The reserved workspace host session is no longer current",
    );
}
