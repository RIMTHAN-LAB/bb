import { setTimeout as sleep } from "node:timers/promises";
import { getThread, getEnvironment, listEvents } from "@bb/db";
import type { PrepareThreadConfigurationRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { isDeepStrictEqual } from "node:util";
import type { NativeContext } from "@bb/domain";
import { getLastProviderThreadId } from "./thread-events.js";
import {
  buildExecutionOptions,
  prepareTurnSubmitCommandPayload,
} from "./thread-commands.js";
import {
  claimThreadConfigurationTransition,
  releaseThreadConfigurationTransition,
  hasLiveThreadStartInFlight,
  stopThreadForCurrentState,
} from "./thread-lifecycle.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import {
  recordThreadConfigurationDelivery,
  recordThreadConfigurationRelease,
  setThreadProviderConfiguration,
  readThreadConfigurationDelivery,
  readThreadProviderConfiguration,
} from "./thread-provider-configuration.js";

export async function prepareThreadConfiguration(
  deps: LoggedPendingInteractionWorkSessionDeps,
  threadId: string,
  request: PrepareThreadConfigurationRequest,
): Promise<void> {
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
  },
): Promise<void> {
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
  generation: number,
): Promise<void> {
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
    recordThreadConfigurationRelease(deps.db, threadId, {
      generation,
      releasedProviderSessionId: providerSessionId,
      releasedAt: Date.now(),
    });
  } finally {
    releaseThreadConfigurationTransition(threadId);
  }
}
