import { setTimeout as sleep } from "node:timers/promises";
import {
  getEnvironment,
  findProjectEnvironmentByHostPath,
  getHost,
  getPreparingEnvironment,
  getThread,
  getThreadStartupContext,
  setThreadStartupContext,
  type DbTransaction,
  type EnvironmentRow,
} from "@bb/db";
import type { PrepareThreadWorkspaceRequest } from "@bb/server-contract";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  advanceEnvironmentProvisioning,
  attachProviderEnvironmentToThread,
  attachProviderEnvironmentToThreadInTransaction,
  cancelProviderEnvironmentCreation,
} from "../environments/environment-engine.js";
import { DEFAULT_ENVIRONMENT_PROVIDER_ID } from "../environments/environment-provider-ids.js";
import { ENVIRONMENT_HOOK_TIMEOUT_MS } from "../environments/environment-hooks.js";
import { getCurrentHostRuntimeSession, requireThreadRuntimeCapability } from "../hosts/runtime-capability.js";
import { getEnvironmentProvider } from "../plugins/plugin-environment-provider-registry.js";
import { readPendingThreadStartContext } from "./dispatch-attempt.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import { prepareProviderEnvironment, resolveProviderOperationContext } from "./thread-environment-placement.js";
import { claimThreadConfigurationTransition, releaseThreadConfigurationTransition } from "./thread-lifecycle.js";
import { readDispatchReservation } from "./thread-reservations.js";
import { requireThreadWorkspaceOwner, type ThreadWorkspaceOwner } from "./thread-workspace-owner.js";

const checkoutPathSchema = z.object({ path: z.string().min(1) });

function requireReservation(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: PrepareThreadWorkspaceRequest,
): void {
  const thread = getThread(deps.db, threadId);
  if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null)
    throw new ApiError(404, "thread_not_found", "Thread not found");
  const reservation = readDispatchReservation(deps.db, threadId);
  if (reservation === null || "purpose" in reservation)
    throw new ApiError(409, "thread_workspace_reservation_required", "Workspace preparation requires the live ordinary dispatch reservation");
  if (reservation.expiresAt !== request.reservationExpiresAt)
    throw new ApiError(409, "thread_workspace_reservation_stale", "The dispatch reservation changed");
  if (reservation.expiresAt <= Date.now())
    throw new ApiError(410, "thread_reservation_expired", "The deferred thread reservation expired; create a new thread.");
}

function requirePlacement(
  request: PrepareThreadWorkspaceRequest,
  hostId: string,
  path: string | null,
): void {
  if (hostId !== request.expectedHostId || path !== request.expectedWorkspacePath)
    throw new ApiError(409, "thread_workspace_placement_mismatch", "The reserved workspace placement does not match the expected host and path");
}

function readyReplay(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: PrepareThreadWorkspaceRequest,
): boolean {
  requireReservation(deps, threadId, request);
  const thread = getThread(deps.db, threadId)!;
  if (thread.environmentId === null) return false;
  const environment = getEnvironment(deps.db, thread.environmentId);
  if (environment === null || environment.status !== "ready" || environment.teardownStatus !== null || environment.ownerThreadId !== null)
    throw new ApiError(409, "thread_workspace_prepare_unsupported", "The reserved workspace is not ready");
  requirePlacement(request, environment.hostId, environment.path);
  const host = getHost(deps.db, environment.hostId);
  if (environment.projectId !== thread.projectId || host?.phase !== "active" || host.destroyedAt !== null || getCurrentHostRuntimeSession(deps, environment.hostId) === null)
    throw new ApiError(409, "host_runtime_unavailable", "The reserved workspace host runtime is unavailable");
  requireThreadRuntimeCapability(deps, threadId, environment.hostId);
  return true;
}

export async function prepareThreadWorkspace(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: PrepareThreadWorkspaceRequest,
): Promise<void> {
  if (!claimThreadConfigurationTransition(threadId))
    throw new ApiError(409, "thread_configuration_busy", "The thread configuration is already transitioning");
  try {
    await withThreadContextClearGuard(threadId, async () => {
      if (readyReplay(deps, threadId, request)) return;
      const thread = getThread(deps.db, threadId)!;
      const pending = readPendingThreadStartContext(deps, threadId);
      const intent = pending?.environmentIntent;
      if (
        pending === null ||
        pending.reservationExpiresAt !== request.reservationExpiresAt ||
        pending.fork !== null ||
        (pending.providerInput?.length ?? 0) !== 0 ||
        intent?.type !== "provider" ||
        intent.environmentProviderId !== DEFAULT_ENVIRONMENT_PROVIDER_ID.projectCheckout ||
        intent.machine.type !== "existing" ||
        !intent.selectionResolved
      )
        throw new ApiError(409, "thread_workspace_prepare_unsupported", "Workspace preparation supports a fresh existing-host unmanaged reservation");
      const path = checkoutPathSchema.safeParse(intent.inputs);
      if (!path.success)
        throw new ApiError(409, "thread_workspace_prepare_unsupported", "The reserved checkout has no explicit workspace path");
      requirePlacement(request, intent.machine.hostId, path.data.path);
      const session = getCurrentHostRuntimeSession(deps, intent.machine.hostId);
      const startupContext = getThreadStartupContext(deps.db, threadId);
      if (session === null || startupContext === null)
        throw new ApiError(409, "host_runtime_unavailable", "The reserved workspace host runtime is unavailable");
      const deadline = Math.min(Date.now() + (request.timeoutMs ?? 30_000), request.reservationExpiresAt);
      const owner: ThreadWorkspaceOwner = {
        threadId,
        expiresAt: request.reservationExpiresAt,
        deadlineAt: deadline,
        startupContext,
        hostId: intent.machine.hostId,
        hostSessionId: session.id,
        workspacePath: path.data.path,
      };
      requireThreadWorkspaceOwner(deps, owner);
      const record = getEnvironmentProvider(intent.environmentProviderId);
      if (record === undefined)
        throw new ApiError(502, "thread_workspace_prepare_failed", "The reserved environment provider is unavailable");
      let prepared = getPreparingEnvironment(deps.db, threadId);
      let attachedEnvironmentId: string | null = null;
      const admitReady = (tx: DbTransaction, environment: EnvironmentRow): void => {
        requireThreadWorkspaceOwner(deps, owner, tx);
        requirePlacement(request, environment.hostId, environment.path);
        if (
          environment.projectId !== thread.projectId ||
          environment.status !== "ready" ||
          environment.teardownStatus !== null ||
          (environment.ownerThreadId !== null && environment.ownerThreadId !== threadId) ||
          (environment.environmentProviderId !== null && (environment.environmentProviderId !== record.provider.id || environment.environmentProviderPluginId !== record.pluginId))
        )
          throw new ApiError(409, "thread_workspace_prepare_unsupported", "The shared reserved workspace is not ready for this thread");
        setThreadStartupContext(tx, {
          threadId,
          startupContext: JSON.stringify({ ...pending, kind: "pending", environmentIntent: { type: "reuse", environmentId: environment.id } }),
        });
      };
      const attachReady = (tx: DbTransaction, environment: EnvironmentRow): void => {
        attachProviderEnvironmentToThreadInTransaction(deps, tx, {
          environment,
          threadId,
          admit: (current) => admitReady(current, environment),
        });
        attachedEnvironmentId = environment.id;
      };
      try {
        if (prepared !== null && (prepared.teardownStatus !== null || prepared.status === "error" || prepared.status === "destroyed"))
          throw new ApiError(502, "thread_workspace_prepare_failed", "The reserved environment requires cleanup; create a new thread after this reservation expires");
        const existing = findProjectEnvironmentByHostPath(deps.db, thread.projectId, owner.hostId, owner.workspacePath);
        if (prepared === null && existing !== null && existing.ownerThreadId !== threadId) {
          await attachProviderEnvironmentToThread(deps, {
            environment: existing,
            threadId,
            admit: (tx) => admitReady(tx, existing),
          });
          return;
        }
        const deadlineController = new AbortController();
        const operation = await Promise.race([
          resolveProviderOperationContext(deps, thread, intent, record),
          sleep(Math.max(0, deadline - Date.now()), undefined, { signal: deadlineController.signal, ref: false }).then(() => { throw new ApiError(504, "thread_workspace_prepare_timeout", "Reserved workspace preparation timed out"); }),
        ]).finally(() => deadlineController.abort());
        requireThreadWorkspaceOwner(deps, owner);
        if (operation === null)
          throw new ApiError(502, "thread_workspace_prepare_failed", "The reserved host workspace could not be resolved");
        const beforePreparation = getPreparingEnvironment(deps.db, threadId);
        if (beforePreparation?.id !== prepared?.id || beforePreparation?.attempt !== prepared?.attempt)
          throw new ApiError(409, "thread_workspace_reservation_stale", "The reserved environment preparation changed");
        const decision = prepareProviderEnvironment(deps, record, operation, { advance: false });
        prepared = getPreparingEnvironment(deps.db, threadId);
        if (decision.action === "reject" || prepared === null)
          throw new ApiError(502, "thread_workspace_prepare_failed", decision.action === "reject" ? decision.message : "The reserved environment was not created");
        for (let attempt = 0; attempt < 1201 && Date.now() < deadline; attempt++) {
          if (attachedEnvironmentId !== null) {
            if (getThread(deps.db, threadId)?.environmentId !== attachedEnvironmentId || getCurrentHostRuntimeSession(deps, owner.hostId)?.id !== owner.hostSessionId || !readyReplay(deps, threadId, request))
              throw new ApiError(409, "thread_workspace_reservation_stale", "The admitted reserved workspace changed");
            return;
          }
          requireThreadWorkspaceOwner(deps, owner);
          const current = getPreparingEnvironment(deps.db, threadId);
          if (current === null || current.id !== prepared.id || current.attempt !== prepared.attempt || current.teardownStatus !== null)
            throw new ApiError(409, "thread_workspace_reservation_stale", "The reserved environment preparation changed");
          if (current.status === "error" || current.status === "destroyed")
            throw new ApiError(502, "thread_workspace_prepare_failed", current.statusMessage ?? "Reserved workspace preparation failed");
          if (current.status === "ready") {
            requirePlacement(request, current.hostId, current.path);
            if (current.projectId !== thread.projectId)
              throw new ApiError(409, "thread_workspace_placement_mismatch", "The workspace project changed");
            await attachProviderEnvironmentToThread(deps, {
              environment: current,
              threadId,
              admit: (tx) => admitReady(tx, current),
            });
            return;
          }
          await advanceEnvironmentProvisioning(deps, {
            environmentId: current.id,
            workspacePreparation: { owner, attachReady },
            creation: { record, context: operation },
            ...(current.path === null ? {} : {
              request: { command: buildEnvironmentProvisionCommand({
                environmentId: current.id,
                hostId: current.hostId,
                initiator: null,
                path: current.path,
                setupScriptTimeoutMs: current.providerOwnsPath ? ENVIRONMENT_HOOK_TIMEOUT_MS : null,
              }) },
            }),
          });
          await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
        }
        requireThreadWorkspaceOwner(deps, owner);
        throw new ApiError(504, "thread_workspace_prepare_timeout", "Reserved workspace preparation timed out");
      } catch (error) {
        if (prepared !== null)
          void cancelProviderEnvironmentCreation(deps, threadId, {
            environmentId: prepared.id,
            attempt: prepared.attempt,
          }).catch((cleanupError) => deps.logger.warn({ threadId, error: cleanupError }, "Reserved workspace cleanup will retry"));
        throw error;
      }
    });
  } finally {
    releaseThreadConfigurationTransition(threadId);
  }
}
