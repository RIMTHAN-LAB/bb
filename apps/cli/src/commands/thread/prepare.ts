import { Command } from "commander";
import { releaseThreadConfigurationRequestSchema } from "@bb/server-contract";
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
      "Release an idle native session for managed configuration or exact legacy adoption",
    )
    .requiredOption(
      "--generation <number|null>",
      "Current generation, or null for an unmanaged retained conversation",
    )
    .option(
      "--expected-provider-session <id>",
      "Exact stored native session required for adoption or recovery",
    )
    .option(
      "--recover-adoption <attempt-id>",
      "Recover the exact adoption attempt",
    )
    .option(
      "--expected-native-context-json <json|null>",
      "Exact observed native context, or null before any configuration PATCH",
    )
    .option("--json", "Output JSON")
    .action(
      action(
        async (
          threadId: string,
          options: {
            generation: string;
            expectedProviderSession?: string;
            recoverAdoption?: string;
            expectedNativeContextJson?: string;
            json?: boolean;
          },
        ) => {
          if (
            (options.recoverAdoption === undefined) !==
            (options.expectedNativeContextJson === undefined)
          )
            throw new Error(
              "--recover-adoption and --expected-native-context-json must be provided together",
            );
          const expectedNativeContext: unknown =
            options.expectedNativeContextJson === undefined
              ? undefined
              : JSON.parse(options.expectedNativeContextJson);
          const request = releaseThreadConfigurationRequestSchema.parse({
            configurationGeneration:
              options.generation === "null" ? null : Number(options.generation),
            ...(options.expectedProviderSession === undefined
              ? {}
              : { expectedProviderSessionId: options.expectedProviderSession }),
            ...(options.recoverAdoption === undefined
              ? {}
              : {
                  recoverAdoption: {
                    attemptId: options.recoverAdoption,
                    expectedNativeContext,
                  },
                }),
          });
          const result = await createCliBbSdk(
            getUrl(),
          ).threads.releaseConfiguration({ threadId, ...request });
          if (!outputJson(options, result))
            console.log(
              `Released provider configuration for ${threadId} at generation ${request.configurationGeneration ?? "unmanaged"}`,
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
    .option(
      "--adoption-attempt <id>",
      "Exact retained-conversation adoption attempt",
    )
    .option("--json", "Output JSON")
    .option(
      "--timeout-ms <number>",
      "Delivery deadline in milliseconds (up to 60000)",
    )
    .action(
      action(
        async (
          threadId: string,
          options: {
            generation: string;
            timeoutMs?: string;
            adoptionAttempt?: string;
            json?: boolean;
          },
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
            ...(options.adoptionAttempt === undefined
              ? {}
              : { adoptionAttemptId: options.adoptionAttempt }),
          });
          if (!outputJson(options, result))
            console.log(
              `Prepared provider configuration for ${threadId} at generation ${configurationGeneration}`,
            );
        },
      ),
    );
}
