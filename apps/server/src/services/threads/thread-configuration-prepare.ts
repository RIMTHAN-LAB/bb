import { setTimeout as sleep } from "node:timers/promises";
import {
  getThread,
  getEnvironment,
  listEvents,
  hasQueuedThreadMessages,
  listActiveBackgroundTaskCountsByThreadIds,
  listUnarchivedAssignedChildThreads,
  threadDispatchReservations,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import type {
  PrepareThreadConfigurationRequest,
  ReleaseThreadConfigurationRequest,
} from "@bb/server-contract";
import { eq } from "drizzle-orm";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { isDeepStrictEqual } from "node:util";
import type { NativeContext } from "@bb/domain";
import { getLastProviderThreadId, getActiveTurnId } from "./thread-events.js";
import {
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  claimThreadConfigurationTransition,
  releaseThreadConfigurationTransition,
  hasLiveThreadStartInFlight,
  requireNoThreadConfigurationTransition,
  stopThreadForCurrentState,
} from "./thread-lifecycle.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { requireThreadNativeHostRuntime } from "../hosts/runtime-capability.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import {
  recordThreadConfigurationDelivery,
  recordThreadConfigurationRelease,
  setThreadProviderConfiguration,
  readThreadConfigurationDelivery,
  readThreadProviderConfiguration,
} from "./thread-provider-configuration.js";
import {
  readThreadAdoptionReservation,
  requireThreadAdoptionAttempt,
  reserveThreadConfigurationAdoption,
  markThreadConfigurationAdoptionFailed,
} from "./thread-reservations.js";
import { getThreadProvisionContext } from "./thread-startup-store.js";
import { withThreadContextClearGuard } from "./thread-context-mutation-guard.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";

export async function prepareThreadConfiguration(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: PrepareThreadConfigurationRequest,
): Promise<void> {
  requireThreadNativeHostRuntime(deps, threadId);
  const adoption = requireThreadAdoptionAttempt(
    deps.db,
    threadId,
    request.adoptionAttemptId,
  );
  const desired = readThreadProviderConfiguration(deps.db, threadId);
  if (
    desired === null ||
    desired.generation !== request.configurationGeneration
  )
    throw new ApiError(
      409,
      "configuration_generation_stale",
      "The exact thread configuration generation does not match",
    );
  const thread = getThread(deps.db, threadId);
  if (
    thread === null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null
  )
    throw new ApiError(404, "thread_not_found", "Thread not found");
  if (
    desired.release !== undefined &&
    desired.generation <= desired.release.generation
  )
    throw new ApiError(
      409,
      "configuration_generation_stale",
      "A released provider requires an advanced configuration generation before prepare",
    );
  const previous = readThreadConfigurationDelivery(deps.db, threadId);
  if (
    previous?.generation === desired.generation &&
    desired.release === undefined
  )
    return;
  if (thread.status === "idle" || thread.status === "error") {
    if (!claimThreadConfigurationTransition(threadId))
      throw new ApiError(
        409,
        "thread_configuration_busy",
        "Provider configuration is already transitioning",
      );
    try {
      const environment =
        thread.environmentId === null
          ? null
          : getEnvironment(deps.db, thread.environmentId);
      if (environment === null || environment.status !== "ready")
        throw new ApiError(
          409,
          "configuration_prepare_environment_unavailable",
          "Configuration preparation requires the existing ready environment",
        );
      const execution = await buildExecutionOptions(
        deps,
        {},
        { threadId, hostId: environment.hostId },
      );
      const prepared = await prepareTurnSubmitCommandPayload(deps, {
        environment,
        execution,
        input: [],
        permissionEscalation: "deny",
        target: { mode: "start" },
        thread,
      });
      const result = await callHostOnlineRpcForWork(deps, {
        hostId: environment.hostId,
        timeoutMs: request.timeoutMs ?? 30_000,
        command: {
          type: "thread.configuration.prepare",
          environmentId: environment.id,
          threadId,
          bridgeLaunch: prepared.bridgeLaunch,
          options: prepared.options,
          resumeContext: prepared.resumeContext,
        },
      });
      requireThreadNativeHostRuntime(deps, threadId);
      requireThreadAdoptionAttempt(
        deps.db,
        threadId,
        request.adoptionAttemptId,
      );
      if (
        adoption !== null &&
        result.providerThreadId !== adoption.providerSessionId
      )
        throw new ApiError(
          409,
          "configuration_adoption_session_mismatch",
          "Preparation did not resume the retained native session",
        );
      if (result.configurationDelivery !== undefined)
        recordThreadConfigurationDelivery(
          deps.db,
          result.configurationDelivery,
          {
            threadId,
            providerId: thread.providerId,
            providerSessionId: result.providerThreadId,
          },
        );
      if (
        readThreadConfigurationDelivery(deps.db, threadId)?.generation !==
        desired.generation
      )
        throw new ApiError(
          503,
          "configuration_prepare_failed",
          "Exact provider configuration was not observed",
        );
      return;
    } catch (error) {
      markThreadConfigurationAdoptionFailed(
        deps.db,
        threadId,
        request.adoptionAttemptId,
        error instanceof ApiError
          ? error.body.code
          : "configuration_prepare_failed",
      );
      throw error;
    } finally {
      releaseThreadConfigurationTransition(threadId);
    }
  }
  if (thread.status !== "pending")
    throw new ApiError(
      409,
      "configuration_prepare_requires_reservation",
      "Prepare requires a reserved thread before first dispatch or an existing delivery observation",
    );
  await attemptDispatch(deps, {
    thread,
    payload: { input: [], mode: "start" },
    source: { kind: "inline" },
    queuePayload: { kind: "inline" },
    origin: "sdk",
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "user",
  });
  const deadline = Date.now() + (request.timeoutMs ?? 30_000);
  for (let attempt = 0; attempt < 1201 && Date.now() <= deadline; attempt++) {
    const current = readThreadProviderConfiguration(deps.db, threadId);
    if (current?.generation !== desired.generation)
      throw new ApiError(
        409,
        "configuration_generation_stale",
        "Configuration changed while preparing the provider session",
      );
    const delivery = readThreadConfigurationDelivery(deps.db, threadId);
    if (delivery?.generation === desired.generation) return;
    const state = getThread(deps.db, threadId);
    if (state?.status === "error") {
      const refusal = listEvents(deps.db, { threadId })
        .reverse()
        .find(
          (event) =>
            event.type === "system/error" &&
            JSON.parse(event.data).code === "agent_configuration_refused",
        );
      if (refusal !== undefined)
        throw new ApiError(
          409,
          "agent_configuration_refused",
          "Managed plugin configuration was refused before provider dispatch",
        );
    }
    if (
      state === null ||
      state.archivedAt !== null ||
      state.deletedAt !== null ||
      state.status === "error"
    )
      throw new ApiError(
        503,
        "configuration_prepare_failed",
        "Provider session preparation failed",
      );
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new ApiError(
    504,
    "configuration_prepare_timeout",
    "Provider configuration delivery was not observed before the prepare deadline",
    true,
  );
}

export async function updateThreadProviderConfiguration(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  patch: {
    nativeContext?: NativeContext;
    configurationGeneration?: number;
    releaseProviderSession?: true;
    adoptionAttemptId?: string;
  },
): Promise<void> {
  requireThreadNativeHostRuntime(deps, threadId);
  requireNoThreadConfigurationTransition(threadId);
  if (
    requireThreadAdoptionAttempt(deps.db, threadId, patch.adoptionAttemptId) !==
    null
  ) {
    setThreadProviderConfiguration(deps, threadId, patch);
    return;
  }
  const previous = readThreadProviderConfiguration(deps.db, threadId);
  const thread = getThread(deps.db, threadId);
  if (thread === null)
    throw new ApiError(404, "thread_not_found", "Thread not found");
  const changed =
    previous !== null &&
    ((patch.configurationGeneration !== undefined &&
      patch.configurationGeneration !== previous.generation) ||
      (patch.nativeContext !== undefined &&
        !isDeepStrictEqual(previous.nativeContext, patch.nativeContext)));
  if (!changed || thread.status === "pending") {
    setThreadProviderConfiguration(deps, threadId, patch);
    return;
  }
  if (patch.releaseProviderSession !== true)
    throw new ApiError(
      409,
      "configuration_release_required",
      "An advanced configuration requires explicit releaseProviderSession before reprepare",
    );
  if (
    !["idle", "error"].includes(thread.status) ||
    hasLiveThreadStartInFlight(threadId)
  )
    throw new ApiError(
      409,
      "thread_configuration_busy",
      "An active provider session cannot be reconfigured",
    );
  if (
    patch.configurationGeneration === undefined ||
    patch.configurationGeneration <= previous.generation
  )
    throw new ApiError(
      409,
      "configuration_generation_stale",
      "Configuration changes require an advanced generation",
    );
  if (
    patch.nativeContext !== undefined &&
    patch.nativeContext.homePath !== previous.nativeContext?.homePath
  )
    throw new ApiError(
      409,
      "native_context_immutable",
      "The thread's native home is immutable",
    );
  if (!claimThreadConfigurationTransition(threadId))
    throw new ApiError(
      409,
      "thread_configuration_busy",
      "Provider configuration is already transitioning",
    );
  try {
    const environment =
      thread.environmentId === null
        ? null
        : getEnvironment(deps.db, thread.environmentId);
    if (previous.release?.generation !== previous.generation) {
      const providerSessionId = getLastProviderThreadId(deps, threadId);
      if (providerSessionId === null)
        throw new ApiError(
          409,
          "configuration_release_session_unavailable",
          "An existing provider session is required for release",
        );
      await stopThreadForCurrentState(
        deps,
        thread,
        environment === null
          ? null
          : { id: environment.id, hostId: environment.hostId },
        { requireStopped: true },
      );
      if (
        !isDeepStrictEqual(
          previous,
          readThreadProviderConfiguration(deps.db, threadId),
        )
      )
        throw new ApiError(
          409,
          "configuration_generation_stale",
          "Configuration changed during provider release",
        );
      requireThreadNativeHostRuntime(deps, threadId);
      recordThreadConfigurationRelease(deps.db, threadId, {
        generation: previous.generation,
        releasedProviderSessionId: providerSessionId,
        releasedAt: Date.now(),
      });
    }
    setThreadProviderConfiguration(deps, threadId, patch);
  } finally {
    releaseThreadConfigurationTransition(threadId);
  }
}

export async function releaseThreadConfiguration(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: ReleaseThreadConfigurationRequest,
): Promise<void> {
  requireThreadNativeHostRuntime(deps, threadId);
  if ("expectedProviderSessionId" in request) {
    await releaseUnmanagedThreadConfiguration(deps, threadId, request);
    return;
  }
  const generation = request.configurationGeneration;
  const desired = readThreadProviderConfiguration(deps.db, threadId);
  const thread = getThread(deps.db, threadId);
  if (
    thread === null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null
  )
    throw new ApiError(404, "thread_not_found", "Thread not found");
  if (desired?.generation !== generation)
    throw new ApiError(
      409,
      "configuration_generation_stale",
      "Release requires the current configuration generation",
    );
  if (
    !["idle", "error"].includes(thread.status) ||
    hasLiveThreadStartInFlight(threadId)
  )
    throw new ApiError(
      409,
      "thread_configuration_busy",
      "An active provider session cannot be released for configuration",
    );
  const providerSessionId = getLastProviderThreadId(deps, threadId);
  if (providerSessionId === null)
    throw new ApiError(
      409,
      "configuration_release_session_unavailable",
      "An existing provider session is required for release",
    );
  const adoption = readThreadAdoptionReservation(deps.db, threadId);
  if (adoption !== null) {
    requireAdoptionQuiescent(deps, deps.db, threadId, true);
    const delivery = readThreadConfigurationDelivery(deps.db, threadId);
    if (
      delivery === null ||
      delivery.generation !== generation ||
      delivery.providerSessionId !== providerSessionId ||
      delivery.providerInstanceId === undefined ||
      providerSessionId !== adoption.providerSessionId ||
      !isDeepStrictEqual(delivery.nativeContext, desired.nativeContext)
    )
      throw new ApiError(
        409,
        "configuration_adoption_retry_required",
        "An adoption without exact managed delivery requires explicit recovery",
      );
  }
  if (
    desired.release?.generation === generation &&
    desired.release.releasedProviderSessionId === providerSessionId
  )
    return;
  if (!claimThreadConfigurationTransition(threadId))
    throw new ApiError(
      409,
      "thread_configuration_busy",
      "Provider configuration is already transitioning",
    );
  try {
    const environment =
      thread.environmentId === null
        ? null
        : getEnvironment(deps.db, thread.environmentId);
    if (environment === null)
      throw new ApiError(
        409,
        "configuration_prepare_environment_unavailable",
        "Provider release requires its existing environment",
      );
    await stopThreadForCurrentState(
      deps,
      thread,
      { id: environment.id, hostId: environment.hostId },
      { requireStopped: true },
    );
    if (
      !isDeepStrictEqual(
        desired,
        readThreadProviderConfiguration(deps.db, threadId),
      )
    )
      throw new ApiError(
        409,
        "configuration_generation_stale",
        "Configuration changed during provider release",
      );
    deps.db.transaction(
      (tx) => {
        requireThreadNativeHostRuntime(deps, threadId);
        if (adoption !== null) {
          requireAdoptionQuiescent(deps, tx, threadId, true);
          if (
            readThreadAdoptionReservation(tx, threadId)?.attemptId !==
              adoption.attemptId ||
            getLastProviderThreadId({ db: tx }, threadId) !== providerSessionId
          )
            throw new ApiError(
              409,
              "configuration_adoption_stale",
              "The adoption changed during managed release",
            );
        }
        recordThreadConfigurationRelease(tx, threadId, {
          generation,
          releasedProviderSessionId: providerSessionId,
          releasedAt: Date.now(),
        });
        if (adoption !== null)
          tx.delete(threadDispatchReservations)
            .where(eq(threadDispatchReservations.threadId, threadId))
            .run();
      },
      { behavior: "immediate" },
    );
  } finally {
    releaseThreadConfigurationTransition(threadId);
  }
}

function requireAdoptionQuiescent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  db: DbConnection | DbTransaction,
  threadId: string,
  allowError: boolean,
) {
  const thread = getThread(db, threadId);
  if (
    thread === null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null
  )
    throw new ApiError(404, "thread_not_found", "Thread not found");
  const activity = listActiveBackgroundTaskCountsByThreadIds(db, {
    threadIds: [threadId],
  })[0];
  if (
    (thread.status !== "idle" && !(allowError && thread.status === "error")) ||
    hasLiveThreadStartInFlight(threadId) ||
    getThreadProvisionContext(db, threadId) !== null ||
    getActiveTurnId({ ...deps, db }, threadId) !== null ||
    hasQueuedThreadMessages(db, threadId) ||
    listUnarchivedAssignedChildThreads(db, { parentThreadId: threadId }).some(
      (child) =>
        ["starting", "active", "stopping"].includes(child.status) ||
        hasLiveThreadStartInFlight(child.id) ||
        getThreadProvisionContext(db, child.id) !== null ||
        getActiveTurnId({ db }, child.id) !== null,
    ) ||
    (activity !== undefined &&
      (activity.activeBackgroundAgentCount > 0 ||
        activity.activeBackgroundCommandCount > 0 ||
        activity.activeWorkflowCount > 0))
  )
    throw new ApiError(
      409,
      "thread_configuration_busy",
      "Adoption requires the exact idle thread without queued input or active background work",
    );
  return thread;
}

async function releaseUnmanagedThreadConfiguration(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: Extract<
    ReleaseThreadConfigurationRequest,
    { expectedProviderSessionId: string }
  >,
): Promise<void> {
  if (!claimThreadConfigurationTransition(threadId))
    throw new ApiError(
      409,
      "thread_configuration_busy",
      "Provider configuration is already transitioning",
    );
  try {
    await withThreadContextClearGuard(threadId, async () => {
      const recovering = "recoverAdoption" in request;
      const desired = readThreadProviderConfiguration(deps.db, threadId);
      const adoption = readThreadAdoptionReservation(deps.db, threadId);
      if (
        recovering &&
        adoption?.attemptId !== request.recoverAdoption.attemptId
      )
        throw new ApiError(
          409,
          "configuration_adoption_stale",
          "The adoption attempt is no longer current",
        );
      const thread = requireAdoptionQuiescent(
        deps,
        deps.db,
        threadId,
        recovering,
      );
      const providerSessionId = getLastProviderThreadId(deps, threadId);
      if (
        providerSessionId === null ||
        providerSessionId !== request.expectedProviderSessionId ||
        (adoption !== null && adoption.providerSessionId !== providerSessionId)
      )
        throw new ApiError(
          409,
          "configuration_adoption_session_mismatch",
          "The retained native session does not match",
        );
      if (
        (desired?.generation ?? null) !== request.configurationGeneration ||
        (recovering &&
          !isDeepStrictEqual(
            desired?.nativeContext ?? null,
            request.recoverAdoption.expectedNativeContext,
          ))
      )
        throw new ApiError(
          409,
          "configuration_adoption_stale",
          "The staged configuration changed before recovery",
        );
      if (readThreadConfigurationDelivery(deps.db, threadId) !== null)
        throw new ApiError(
          409,
          "configuration_adoption_managed",
          "A managed provider requires its normal configuration release",
        );
      if (!recovering && desired !== null)
        throw new ApiError(
          409,
          "configuration_generation_stale",
          "Initial adoption requires an unmanaged thread",
        );
      if (
        adoption !== null &&
        adoption.state === "reserved" &&
        adoption.expiresAt > Date.now()
      )
        return;
      if (adoption !== null && !recovering)
        throw new ApiError(
          409,
          "configuration_adoption_retry_required",
          "Expired adoption requires exact explicit recovery",
        );
      const environment =
        thread.environmentId === null
          ? null
          : getEnvironment(deps.db, thread.environmentId);
      if (environment === null)
        throw new ApiError(
          409,
          "configuration_prepare_environment_unavailable",
          "Adoption requires its existing environment",
        );
      await stopThreadForCurrentState(
        deps,
        thread,
        { id: environment.id, hostId: environment.hostId },
        { requireStopped: true },
      );
      deps.db.transaction(
        (tx) => {
          requireThreadNativeHostRuntime(deps, threadId);
          const current = requireAdoptionQuiescent(
            deps,
            tx,
            threadId,
            recovering,
          );
          const currentAdoption = readThreadAdoptionReservation(tx, threadId);
          if (
            current.providerId !== thread.providerId ||
            current.environmentId !== thread.environmentId ||
            current.projectId !== thread.projectId ||
            getLastProviderThreadId({ db: tx }, threadId) !==
              providerSessionId ||
            !isDeepStrictEqual(
              desired,
              readThreadProviderConfiguration(tx, threadId),
            ) ||
            currentAdoption?.attemptId !== adoption?.attemptId ||
            readThreadConfigurationDelivery(tx, threadId) !== null
          )
            throw new ApiError(
              409,
              "configuration_adoption_stale",
              "The exact adoption authority changed during provider release",
            );
          reserveThreadConfigurationAdoption(tx, {
            threadId,
            providerSessionId,
            stoppedAt: Date.now(),
            released: desired,
          });
          if (current.status === "error") {
            const outcome = applyLoggedThreadLifecycleEventInTransaction(
              { ...deps, db: tx },
              { threadId, event: { type: "stop.settled" } },
            );
            if (!outcome.applied)
              throw new ApiError(
                409,
                "configuration_adoption_stale",
                "The stopped thread changed before recovery settled",
              );
          }
        },
        { behavior: "immediate" },
      );
      if (thread.status === "error")
        deps.hub.notifyThread(threadId, ["status-changed"]);
    });
  } finally {
    releaseThreadConfigurationTransition(threadId);
  }
}
