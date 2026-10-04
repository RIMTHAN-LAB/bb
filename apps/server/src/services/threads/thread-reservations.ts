import {
  archiveThread,
  getEnvironment,
  getThread,
  threadDispatchReservations,
  threads,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import { and, eq, isNull, lte } from "drizzle-orm";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import { stopThreadForCurrentState } from "./thread-lifecycle.js";

export const THREAD_RESERVATION_TTL_MS = 5 * 60_000;

export function readDispatchReservation(
  db: DbConnection | DbTransaction,
  threadId: string,
): { expiresAt: number } | null {
  return (
    db
      .select({ expiresAt: threadDispatchReservations.expiresAt })
      .from(threadDispatchReservations)
      .where(eq(threadDispatchReservations.threadId, threadId))
      .get() ?? null
  );
}

export function requireUnexpiredDispatchReservation(
  db: DbConnection | DbTransaction,
  threadId: string,
): void {
  const reservation = readDispatchReservation(db, threadId);
  if (reservation !== null && reservation.expiresAt <= Date.now())
    throw new ApiError(
      410,
      "thread_reservation_expired",
      "The deferred thread reservation expired; create a new thread.",
    );
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
      ),
    )
    .limit(100)
    .all();
  let expired = 0;
  for (const candidate of candidates) {
    const archived = deps.db.transaction(
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
        const result = archiveThread(tx, deps.hub, thread.id);
        tx.delete(threadDispatchReservations)
          .where(eq(threadDispatchReservations.threadId, thread.id))
          .run();
        return result;
      },
      { behavior: "immediate" },
    );
    if (archived !== null) {
      emitPluginThreadArchived(archived);
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
