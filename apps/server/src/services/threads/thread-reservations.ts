import {
  archiveThread,
  getEnvironment,
  getThread,
  threadDispatchReservations,
  threads,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  nativeContextSchema,
  type ThreadProviderConfiguration,
} from "@bb/domain";
import { threadConfigurationAdoptionReservationSchema } from "@bb/server-contract";
import { z } from "zod";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";
import {
  readThreadConfigurationDelivery,
  readThreadProviderConfiguration,
} from "./thread-provider-configuration.js";

export const THREAD_RESERVATION_TTL_MS = 5 * 60_000;

const adoptionMetadataSchema = threadConfigurationAdoptionReservationSchema
  .omit({ expiresAt: true })
  .extend({
    releasedConfiguration: z
      .object({
        generation: z.number().int().nonnegative().nullable(),
        nativeContext: nativeContextSchema.nullable(),
      })
      .strict(),
    failure: z
      .object({ code: z.string(), at: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();

export function readThreadAdoptionReservation(
  db: DbConnection | DbTransaction,
  threadId: string,
) {
  const row = db
    .select()
    .from(threadDispatchReservations)
    .where(eq(threadDispatchReservations.threadId, threadId))
    .get();
  if (row?.adoption == null) return null;
  const adoption = adoptionMetadataSchema.parse(JSON.parse(row.adoption));
  return { ...adoption, expiresAt: row.expiresAt };
}

export function reserveThreadConfigurationAdoption(
  tx: DbTransaction,
  args: {
    threadId: string;
    providerSessionId: string;
    stoppedAt: number;
    released: ThreadProviderConfiguration | null;
  },
) {
  const adoption = adoptionMetadataSchema.parse({
    purpose: "configuration-adoption",
    attemptId: randomUUID(),
    providerSessionId: args.providerSessionId,
    stoppedAt: args.stoppedAt,
    state: "reserved",
    releasedConfiguration: {
      generation: args.released?.generation ?? null,
      nativeContext: args.released?.nativeContext ?? null,
    },
  });
  tx.insert(threadDispatchReservations)
    .values({
      threadId: args.threadId,
      expiresAt: args.stoppedAt + THREAD_RESERVATION_TTL_MS,
      adoption: JSON.stringify(adoption),
    })
    .onConflictDoUpdate({
      target: threadDispatchReservations.threadId,
      set: {
        expiresAt: args.stoppedAt + THREAD_RESERVATION_TTL_MS,
        adoption: JSON.stringify(adoption),
      },
    })
    .run();
}

export function requireThreadAdoptionAttempt(
  db: DbConnection | DbTransaction,
  threadId: string,
  attemptId: string | undefined,
) {
  const adoption = readThreadAdoptionReservation(db, threadId);
  if (adoption === null) {
    if (attemptId !== undefined)
      throw new ApiError(
        409,
        "configuration_adoption_stale",
        "The adoption attempt is no longer current",
      );
    return null;
  }
  if (adoption.attemptId !== attemptId)
    throw new ApiError(
      409,
      "configuration_adoption_stale",
      "The exact current adoption attempt is required",
    );
  requireUnexpiredDispatchReservation(db, threadId);
  if (adoption.state !== "reserved")
    throw new ApiError(
      409,
      "configuration_adoption_retry_required",
      "The failed adoption requires explicit recovery",
    );
  return adoption;
}

export function requireThreadAdoptionContextWritable(
  db: DbConnection | DbTransaction,
  threadId: string,
): void {
  if (readThreadAdoptionReservation(db, threadId) !== null)
    throw new ApiError(
      409,
      "configuration_adoption_pending",
      "Native context cannot be replaced during configuration adoption",
    );
}

export function requireThreadAdoptionDispatchReady(
  db: DbConnection | DbTransaction,
  threadId: string,
): void {
  const adoption = readThreadAdoptionReservation(db, threadId);
  if (adoption === null) return;
  requireUnexpiredDispatchReservation(db, threadId);
  const desired = readThreadProviderConfiguration(db, threadId),
    delivery = readThreadConfigurationDelivery(db, threadId);
  const thread = getThread(db, threadId);
  if (
    adoption.state !== "reserved" ||
    desired === null ||
    delivery === null ||
    thread === null ||
    delivery.threadId !== threadId ||
    delivery.providerId !== thread.providerId ||
    delivery.providerSessionId !== adoption.providerSessionId ||
    delivery.providerInstanceId === undefined ||
    delivery.generation !== desired.generation ||
    !isDeepStrictEqual(delivery.nativeContext, desired.nativeContext) ||
    delivery.deliveredAt <= adoption.stoppedAt ||
    delivery.deliveredAt > adoption.expiresAt ||
    (adoption.releasedConfiguration.generation !== null &&
      desired.generation <= adoption.releasedConfiguration.generation)
  )
    throw new ApiError(
      409,
      "configuration_reprepare_required",
      "The adopted conversation requires exact provider preparation before dispatch",
    );
}

export function markThreadConfigurationAdoptionFailed(
  db: DbConnection,
  threadId: string,
  attemptId: string | undefined,
  code: string,
): void {
  if (attemptId === undefined) return;
  const adoption = readThreadAdoptionReservation(db, threadId);
  if (
    adoption?.attemptId !== attemptId ||
    adoption.state !== "reserved" ||
    adoption.expiresAt <= Date.now() ||
    readThreadConfigurationDelivery(db, threadId) !== null
  )
    return;
  const { expiresAt, ...metadata } = adoption;
  void expiresAt;
  db.update(threadDispatchReservations)
    .set({
      adoption: JSON.stringify({
        ...metadata,
        state: "failed",
        failure: { code, at: Date.now() },
      }),
    })
    .where(eq(threadDispatchReservations.threadId, threadId))
    .run();
}

export function readDispatchReservation(
  db: DbConnection | DbTransaction,
  threadId: string,
):
  | { expiresAt: number }
  | z.infer<typeof threadConfigurationAdoptionReservationSchema>
  | null {
  const row = db
    .select({ expiresAt: threadDispatchReservations.expiresAt })
    .from(threadDispatchReservations)
    .where(eq(threadDispatchReservations.threadId, threadId))
    .get();
  if (row === undefined) return null;
  const adoption = readThreadAdoptionReservation(db, threadId);
  if (adoption === null) return row;
  return threadConfigurationAdoptionReservationSchema.parse({
    purpose: adoption.purpose,
    attemptId: adoption.attemptId,
    providerSessionId: adoption.providerSessionId,
    stoppedAt: adoption.stoppedAt,
    expiresAt: adoption.expiresAt,
    state: adoption.expiresAt <= Date.now() ? "expired" : adoption.state,
  });
}

export function requireUnexpiredDispatchReservation(
  db: DbConnection | DbTransaction,
  threadId: string,
): void {
  const reservation = readDispatchReservation(db, threadId);
  if (reservation !== null && reservation.expiresAt <= Date.now()) {
    if ("purpose" in reservation)
      throw new ApiError(
        409,
        "configuration_adoption_expired",
        "The adoption lease expired; explicitly recover the retained conversation on this thread",
      );
    throw new ApiError(
      410,
      "thread_reservation_expired",
      "The deferred thread reservation expired; create a new thread.",
    );
  }
}

export function consumeDispatchReservation(
  db: DbTransaction,
  threadId: string,
): void {
  requireUnexpiredDispatchReservation(db, threadId);
  db.delete(threadDispatchReservations)
    .where(eq(threadDispatchReservations.threadId, threadId))
    .run();
}

export function expireDeferredThreadReservations(
  deps: LoggedPendingInteractionWorkSessionDeps,
  now: number,
): number {
  const candidates = deps.db
    .select({ id: threads.id })
    .from(threadDispatchReservations)
    .innerJoin(threads, eq(threadDispatchReservations.threadId, threads.id))
    .where(
      and(
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        lte(threadDispatchReservations.expiresAt, now),
        or(
          isNull(threadDispatchReservations.adoption),
          sql`json_extract(${threadDispatchReservations.adoption}, '$.state') <> 'expired'`,
        ),
      ),
    )
    .limit(100)
    .all();
  let expired = 0;
  for (const candidate of candidates) {
    const result = deps.db.transaction(
      (tx) => {
        const reservation = readDispatchReservation(tx, candidate.id);
        const thread = getThread(tx, candidate.id);
        if (
          reservation === null ||
          reservation.expiresAt > now ||
          thread === null ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null
        )
          return null;
        const adoption = readThreadAdoptionReservation(tx, thread.id);
        if (adoption !== null) {
          const { expiresAt, ...metadata } = adoption;
          void expiresAt;
          tx.update(threadDispatchReservations)
            .set({
              adoption: JSON.stringify({ ...metadata, state: "expired" }),
            })
            .where(eq(threadDispatchReservations.threadId, thread.id))
            .run();
          return { thread, adoption: true };
        }
        const result = archiveThread(tx, deps.hub, thread.id);
        tx.delete(threadDispatchReservations)
          .where(eq(threadDispatchReservations.threadId, thread.id))
          .run();
        return result === null ? null : { thread: result, adoption: false };
      },
      { behavior: "immediate" },
    );
    if (result !== null) {
      const archived = result.thread;
      if (!result.adoption) emitPluginThreadArchived(archived);
      const environment =
        archived.environmentId === null
          ? null
          : getEnvironment(deps.db, archived.environmentId);
      void stopThreadForCurrentState(
        deps,
        archived,
        environment === null
          ? null
          : { id: environment.id, hostId: environment.hostId },
      ).catch((error) =>
        deps.logger.warn(
          { error, threadId: archived.id },
          "Expired reservation provider release failed",
        ),
      );
      expired++;
    }
  }
  return expired;
}
