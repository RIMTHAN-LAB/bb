import { Command } from "commander";
import { prepareThreadWorkspaceRequestSchema } from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson } from "../helpers.js";

export function registerPrepareWorkspaceCommand(
  thread: Command,
  getUrl: () => string,
): void {
  thread
    .command("prepare-workspace <thread-id>")
    .description("Prepare a reserved host workspace without starting a provider or turn")
    .requiredOption("--reservation-expires-at <number>", "Exact existing dispatch reservation expiry in epoch milliseconds")
    .requiredOption("--expected-host <id>", "Compare with the persisted host selection")
    .requiredOption("--expected-workspace <path>", "Compare with the persisted unmanaged workspace path")
    .option("--timeout-ms <number>", "Preparation deadline in milliseconds, up to 60000")
    .option("--json", "Output JSON")
    .action(action(async (threadId: string, options: {
      reservationExpiresAt: string;
      expectedHost: string;
      expectedWorkspace: string;
      timeoutMs?: string;
      json?: boolean;
    }) => {
      const request = prepareThreadWorkspaceRequestSchema.parse({
        reservationExpiresAt: Number(options.reservationExpiresAt),
        expectedHostId: options.expectedHost,
        expectedWorkspacePath: options.expectedWorkspace,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: Number(options.timeoutMs) }),
      });
      const result = await createCliBbSdk(getUrl()).threads.prepareWorkspace({ threadId, ...request });
      if (!outputJson(options, result))
        console.log(`Prepared workspace for ${threadId}`);
    }));
}
