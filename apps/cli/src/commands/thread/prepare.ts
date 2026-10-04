import { Command } from "commander";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { outputJson } from "../helpers.js";

export function registerPrepareConfigurationCommand(
  thread: Command,
  getUrl: () => string,
): void {
  thread
    .command("release-configuration <thread-id>")
    .description(
      "Release an idle provider session before advancing its managed configuration",
    )
    .requiredOption("--generation <number>", "Current configuration generation")
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          threadId: string,
          options: { generation: string; json?: boolean },
        ) => {
          const configurationGeneration = Number(options.generation);
          if (
            !Number.isSafeInteger(configurationGeneration) ||
            configurationGeneration < 0
          )
            throw new Error("Generation must be a nonnegative integer");
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.releaseConfiguration({ threadId, configurationGeneration });
          if (!outputJson(options, result))
            console.log(
              `Released provider configuration for ${threadId} at generation ${configurationGeneration}`,
            );
        },
      ),
    );
  thread
    .command("prepare <thread-id>")
    .description(
      "Construct a reserved provider session without dispatching a model turn",
    )
    .requiredOption("--generation <number>", "Exact configuration generation")
    .option("--json", "Output JSON")
    .option(
      "--timeout-ms <number>",
      "Delivery deadline in milliseconds (up to 60000)",
    )
    .action(
      action(
        async (
          threadId: string,
          options: { generation: string; timeoutMs?: string; json?: boolean },
        ) => {
          const configurationGeneration = Number(options.generation);
          const timeoutMs =
            options.timeoutMs === undefined
              ? undefined
              : Number(options.timeoutMs);
          if (
            !Number.isSafeInteger(configurationGeneration) ||
            configurationGeneration < 0 ||
            (timeoutMs !== undefined &&
              (!Number.isInteger(timeoutMs) ||
                timeoutMs < 1 ||
                timeoutMs > 60_000))
          )
            throw new Error(
              "Generation and timeout must be valid bounded integers",
            );
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.prepareConfiguration({
            threadId,
            configurationGeneration,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
          if (!outputJson(options, result))
            console.log(
              `Prepared provider configuration for ${threadId} at generation ${configurationGeneration}`,
            );
        },
      ),
    );
}
