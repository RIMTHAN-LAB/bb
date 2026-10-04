import {
  getThread,
  threadProviderConfigurations,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  threadProviderConfigurationSchema,
  threadConfigurationDeliverySchema,
  type NativeContext,
  type ThreadConfigurationDelivery,
  type ThreadProviderConfiguration,
  type ThreadConfigurationRelease,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";

type Connection = DbConnection | DbTransaction;

export function readThreadProviderConfiguration(
  db: Connection,
  threadId: string,
): ThreadProviderConfiguration | null {
  const row = db
    .select({ desired: threadProviderConfigurations.desired })
    .from(threadProviderConfigurations)
    .where(eq(threadProviderConfigurations.threadId, threadId))
    .get();
  return row === undefined
    ? null
    : threadProviderConfigurationSchema.parse(JSON.parse(row.desired));
}

export function readThreadConfigurationDelivery(
  db: Connection,
  threadId: string,
): ThreadConfigurationDelivery | null {
  const row = db
    .select({ delivered: threadProviderConfigurations.delivered })
    .from(threadProviderConfigurations)
    .where(eq(threadProviderConfigurations.threadId, threadId))
    .get();
  return row?.delivered == null
    ? null
    : threadConfigurationDeliverySchema.parse(JSON.parse(row.delivered));
}

export function setThreadProviderConfiguration(
  deps: { db: DbConnection; providerRegistry: ProviderRegistryService },
  threadId: string,
  patch: { nativeContext?: NativeContext; configurationGeneration?: number },
): void {
  deps.db.transaction(
    (tx) => {
      const thread = getThread(tx, threadId);
      if (
        thread === null ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null
      )
        throw new ApiError(404, "thread_not_found", "Thread not found");
      if (!["pending", "idle", "error"].includes(thread.status))
        throw new ApiError(
          409,
          "thread_configuration_busy",
          "Provider configuration requires a pending or idle thread",
        );
      const previous = readThreadProviderConfiguration(tx, threadId);
      if (patch.nativeContext !== undefined) {
        if (
          deps.providerRegistry.get(thread.providerId)
            ?.supportsNativeContext !== true
        )
          throw new ApiError(
            400,
            "native_context_unsupported",
            "This provider does not support an exact-thread native home",
          );
        if (
          previous?.nativeContext !== undefined &&
          previous.nativeContext.homePath !== patch.nativeContext.homePath
        )
          throw new ApiError(
            409,
            "native_context_immutable",
            "The thread's native home is immutable",
          );
        if (
          previous?.nativeContext !== undefined &&
          !isDeepStrictEqual(previous.nativeContext, patch.nativeContext) &&
          (patch.configurationGeneration === undefined ||
            patch.configurationGeneration <= previous.generation)
        )
          throw new ApiError(
            409,
            "configuration_generation_stale",
            "Native configuration references require an advanced generation",
          );
        if (
          previous?.nativeContext === undefined &&
          thread.status !== "pending"
        )
          throw new ApiError(
            409,
            "native_context_immutable",
            "A native home must be bound before first dispatch",
          );
      }
      const generation =
        patch.configurationGeneration ?? previous?.generation ?? 0;
      if (previous !== null && generation < previous.generation)
        throw new ApiError(
          409,
          "configuration_generation_stale",
          "Configuration generation cannot move backwards",
        );
      const desired = threadProviderConfigurationSchema.parse({
        generation,
        ...(previous?.release === undefined
          ? {}
          : { release: previous.release }),
        ...(previous?.nativeContext === undefined
          ? {}
          : { nativeContext: previous.nativeContext }),
        ...(patch.nativeContext === undefined
          ? {}
          : { nativeContext: patch.nativeContext }),
      });
      tx.insert(threadProviderConfigurations)
        .values({ threadId, desired: JSON.stringify(desired) })
        .onConflictDoUpdate({
          target: threadProviderConfigurations.threadId,
          set: { desired: JSON.stringify(desired) },
        })
        .run();
    },
    { behavior: "immediate" },
  );
}

export function recordThreadConfigurationDelivery(
  db: Connection,
  delivery: ThreadConfigurationDelivery,
  expected: { threadId: string; providerId: string; providerSessionId: string },
): void {
  const parsed = threadConfigurationDeliverySchema.parse(delivery);
  if (
    parsed.threadId !== expected.threadId ||
    parsed.providerId !== expected.providerId ||
    parsed.providerSessionId !== expected.providerSessionId
  )
    return;
  const thread = getThread(db, parsed.threadId);
  if (
    thread === null ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.providerId !== expected.providerId
  )
    return;
  const desired = readThreadProviderConfiguration(db, parsed.threadId);
  if (
    desired === null ||
    desired.generation !== parsed.generation ||
    !isDeepStrictEqual(desired.nativeContext, parsed.nativeContext)
  )
    return;
  const current = readThreadConfigurationDelivery(db, parsed.threadId);
  if (current !== null && current.deliveredAt > parsed.deliveredAt) return;
  if (
    desired.release !== undefined &&
    (parsed.deliveredAt <= desired.release.releasedAt ||
      parsed.providerInstanceId === undefined ||
      parsed.providerInstanceId === current?.providerInstanceId)
  )
    return;
  const { release, ...withoutRelease } = desired;
  void release;
  db.update(threadProviderConfigurations)
    .set({
      desired: JSON.stringify(withoutRelease),
      delivered: JSON.stringify(parsed),
    })
    .where(eq(threadProviderConfigurations.threadId, parsed.threadId))
    .run();
}

export function recordThreadConfigurationRelease(
  db: Connection,
  threadId: string,
  release: ThreadConfigurationRelease,
): void {
  const desired = readThreadProviderConfiguration(db, threadId);
  if (desired === null || desired.generation !== release.generation)
    throw new ApiError(
      409,
      "configuration_generation_stale",
      "Configuration changed during provider release",
    );
  db.update(threadProviderConfigurations)
    .set({ desired: JSON.stringify({ ...desired, release }) })
    .where(eq(threadProviderConfigurations.threadId, threadId))
    .run();
}

export function consumeThreadConfigurationRelease(
  db: Connection,
  threadId: string,
): void {
  const desired = readThreadProviderConfiguration(db, threadId);
  if (desired?.release === undefined) return;
  const { release, ...withoutRelease } = desired;
  void release;
  db.update(threadProviderConfigurations)
    .set({ desired: JSON.stringify(withoutRelease) })
    .where(eq(threadProviderConfigurations.threadId, threadId))
    .run();
}

export function requirePreparedThreadConfiguration(
  db: Connection,
  threadId: string,
): void {
  if (readThreadProviderConfiguration(db, threadId)?.release !== undefined)
    throw new ApiError(
      409,
      "configuration_reprepare_required",
      "The released provider requires an advanced configuration and exact preparation before dispatch",
    );
}
