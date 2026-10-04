import {
  getEnvironment,
  getSessionById,
  getThread,
  listThreadEnvironmentAssignmentsOnHost,
  threadDispatchReservations,
  threadProviderConfigurations,
  type DbConnection,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonRpcCommand,
} from "@bb/host-daemon-contract";
import type { JsonObject } from "@bb/domain";
import { eq } from "drizzle-orm";
import { ApiError } from "../../errors.js";
import type { NotificationHub } from "../../ws/hub.js";

type RuntimeCapabilityDeps = {
  db: DbConnection;
  hub: Pick<NotificationHub, "getDaemonSessionIdForHost">;
};

export function getCurrentHostRuntimeSession(
  deps: RuntimeCapabilityDeps,
  hostId: string,
): { id: string; protocolVersion: number } | null {
  const session = getActiveHostSocketSession(deps, hostId);
  if (session === null || session.leaseExpiresAt <= Date.now()) return null;
  return { id: session.id, protocolVersion: session.protocolVersion };
}

function getActiveHostSocketSession(
  deps: RuntimeCapabilityDeps,
  hostId: string,
) {
  const id = deps.hub.getDaemonSessionIdForHost(hostId);
  if (id === null) return null;
  const session = getSessionById(deps.db, { sessionId: id });
  if (
    session === null ||
    session.hostId !== hostId ||
    session.status !== "active"
  )
    return null;
  return session;
}

export function requireNativeHostRuntime(
  deps: RuntimeCapabilityDeps,
  hostId: string | null,
): void {
  const session =
    hostId === null ? null : getCurrentHostRuntimeSession(deps, hostId);
  if (session === null)
    throw new ApiError(
      409,
      "host_runtime_unavailable",
      "Native configuration requires a current authenticated host runtime session",
    );
  if (session.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION)
    throw new ApiError(
      409,
      "host_protocol_upgrade_required",
      "Native configuration requires host daemon protocol 204",
    );
}

export function threadRequiresNativeRuntime(
  db: DbConnection,
  threadId: string,
): boolean {
  return (
    db
      .select({ threadId: threadProviderConfigurations.threadId })
      .from(threadProviderConfigurations)
      .where(eq(threadProviderConfigurations.threadId, threadId))
      .get() !== undefined ||
    db
      .select({ adoption: threadDispatchReservations.adoption })
      .from(threadDispatchReservations)
      .where(eq(threadDispatchReservations.threadId, threadId))
      .get()?.adoption != null
  );
}

export function requireDaemonThreadReportCapability(
  db: DbConnection,
  hostId: string,
  protocolVersion: number,
  threadIds: string[],
): void {
  if (protocolVersion === HOST_DAEMON_PROTOCOL_VERSION) return;
  if (
    listThreadEnvironmentAssignmentsOnHost(db, { hostId, threadIds }).some(
      ({ threadId }) => threadRequiresNativeRuntime(db, threadId),
    )
  )
    throw new ApiError(
      409,
      "host_protocol_upgrade_required",
      "Native thread reports require host daemon protocol 204",
    );
}

export function requireThreadNativeHostRuntime(
  deps: RuntimeCapabilityDeps,
  threadId: string,
  hostId?: string | null,
): void {
  const thread = getThread(deps.db, threadId);
  const environment =
    thread?.environmentId == null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  requireNativeHostRuntime(deps, hostId ?? environment?.hostId ?? null);
}

export function requireThreadRuntimeCapability(
  deps: RuntimeCapabilityDeps,
  threadId: string,
  hostId?: string | null,
): void {
  if (threadRequiresNativeRuntime(deps.db, threadId))
    requireThreadNativeHostRuntime(deps, threadId, hostId);
}

function hasNativeProviderOptions(options: JsonObject): boolean {
  return (
    "acpNativeContext" in options || "acpConfigurationGeneration" in options
  );
}

export function requireHostCommandRuntimeCapability(
  deps: RuntimeCapabilityDeps,
  hostId: string,
  sessionId: string,
  command: HostDaemonRpcCommand,
  requireNativeRuntime = false,
  allowStaleReadLease = false,
): void {
  const session = getActiveHostSocketSession(deps, hostId);
  if (session === null || session.id !== sessionId)
    throw new ApiError(
      409,
      "host_runtime_unavailable",
      "The selected host runtime session is no longer current",
    );
  const nativePayload =
    "nativeContext" in command ||
    "configurationGeneration" in command ||
    ("options" in command &&
      hasNativeProviderOptions(command.options.providerOptions)) ||
    ("bridgeLaunch" in command &&
      hasNativeProviderOptions(command.bridgeLaunch.providerOptions)) ||
    ("resumeContext" in command &&
      ("nativeContext" in command.resumeContext ||
        "configurationGeneration" in command.resumeContext ||
        hasNativeProviderOptions(
          command.resumeContext.bridgeLaunch.providerOptions,
        )));
  const cleanup =
    (command.type === "thread.stop" && command.intent !== "release") ||
    command.type === "thread.plan.cancel" ||
    command.type === "thread.rewind.discard";
  const nativeCommand =
    command.type === "thread.configuration.prepare" ||
    requireNativeRuntime ||
    nativePayload ||
    ("threadId" in command &&
      !cleanup &&
      threadRequiresNativeRuntime(deps.db, command.threadId));
  if (
    session.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION &&
    (session.protocolVersion !== 203 || nativeCommand)
  )
    throw new ApiError(
      409,
      "host_protocol_upgrade_required",
      "The selected host daemon cannot execute native configuration commands",
    );
  if (
    session.leaseExpiresAt <= Date.now() &&
    (nativeCommand || !allowStaleReadLease)
  )
    throw new ApiError(
      409,
      "host_runtime_unavailable",
      "The selected host runtime session lease has expired",
    );
}
