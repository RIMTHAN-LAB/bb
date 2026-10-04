import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { makeThread } from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

const nativeContext = {
  homePath: "/workspace/profiles/retained",
  instructionsConfig: {
    path: "/workspace/profiles/retained/instructions",
    sha256: "a".repeat(64),
  },
};

describe("bb retained-thread configuration commands", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it.each([
    { flags: ["--generation", "3"], body: { configurationGeneration: 3 } },
    {
      flags: [
        "--generation",
        "null",
        "--expected-provider-session",
        "native-retained",
      ],
      body: {
        configurationGeneration: null,
        expectedProviderSessionId: "native-retained",
      },
    },
    {
      flags: [
        "--generation",
        "null",
        "--expected-provider-session",
        "native-retained",
        "--recover-adoption",
        "attempt-1",
        "--expected-native-context-json",
        "null",
      ],
      body: {
        configurationGeneration: null,
        expectedProviderSessionId: "native-retained",
        recoverAdoption: {
          attemptId: "attempt-1",
          expectedNativeContext: null,
        },
      },
    },
    {
      flags: [
        "--generation",
        "1",
        "--expected-provider-session",
        "native-retained",
        "--recover-adoption",
        "attempt-1",
        "--expected-native-context-json",
        JSON.stringify(nativeContext),
      ],
      body: {
        configurationGeneration: 1,
        expectedProviderSessionId: "native-retained",
        recoverAdoption: {
          attemptId: "attempt-1",
          expectedNativeContext: nativeContext,
        },
      },
    },
  ])("sends only the exact release arm %#", async ({ flags, body }) => {
    const result = {
      ...makeThread({
        id: "thread-retained",
        projectId: "project-retained",
        providerId: "acp-hermes-agent",
        status: "idle",
      }),
      providerSessionId: "native-retained",
    };
    const release = vi.fn(async () => result);
    stubServerApi({ "v1.threads.:id.configuration.release.$post": release });
    await runCommand(
      [
        "thread",
        "release-configuration",
        "thread-retained",
        ...flags,
        "--json",
      ],
      register,
    );
    expect(release).toHaveBeenCalledExactlyOnceWith({
      param: { id: "thread-retained" },
      json: body,
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(result, null, 2),
    ]);
  });

  it("forwards exact native binding and attempt through update and bounded prepare", async () => {
    const result = {
      ...makeThread({
        id: "thread-retained",
        projectId: "project-retained",
        providerId: "acp-hermes-agent",
        status: "idle",
      }),
      providerSessionId: "native-retained",
    };
    const patch = vi.fn(async () => result);
    const prepare = vi.fn(async () => result);
    stubServerApi({
      "v1.threads.:id.$patch": patch,
      "v1.threads.:id.configuration.prepare.$post": prepare,
    });
    await runCommand(
      [
        "thread",
        "update",
        "thread-retained",
        "--native-context-json",
        JSON.stringify(nativeContext),
        "--configuration-generation",
        "2",
        "--adoption-attempt",
        "attempt-2",
        "--release-provider-session",
        "--json",
      ],
      register,
    );
    expect(patch).toHaveBeenCalledExactlyOnceWith({
      param: { id: "thread-retained" },
      json: {
        nativeContext,
        configurationGeneration: 2,
        adoptionAttemptId: "attempt-2",
        releaseProviderSession: true,
      },
    });
    await runCommand(
      [
        "thread",
        "prepare",
        "thread-retained",
        "--generation",
        "2",
        "--adoption-attempt",
        "attempt-2",
        "--timeout-ms",
        "2000",
        "--json",
      ],
      register,
    );
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      param: { id: "thread-retained" },
      json: {
        configurationGeneration: 2,
        timeoutMs: 2000,
        adoptionAttemptId: "attempt-2",
      },
    });
  });

  it.each([
    { flags: ["--generation", "null"] },
    {
      flags: [
        "--generation",
        "1",
        "--expected-provider-session",
        "native-retained",
      ],
    },
    {
      flags: [
        "--generation",
        "null",
        "--expected-provider-session",
        "native-retained",
        "--recover-adoption",
        "attempt-1",
      ],
    },
    {
      flags: [
        "--generation",
        "1",
        "--expected-provider-session",
        "native-retained",
        "--recover-adoption",
        "attempt-1",
        "--expected-native-context-json",
        "null",
      ],
    },
    {
      flags: [
        "--generation",
        "null",
        "--expected-provider-session",
        "native-retained",
        "--expected-native-context-json",
        "null",
      ],
    },
  ])(
    "refuses incomplete or mixed release flags %# before I/O",
    async ({ flags }) => {
      const release = vi.fn(async () =>
        makeThread({
          id: "thread-retained",
          projectId: "project-retained",
          providerId: "acp-hermes-agent",
        }),
      );
      stubServerApi({ "v1.threads.:id.configuration.release.$post": release });
      await expect(
        runCommand(
          ["thread", "release-configuration", "thread-retained", ...flags],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
      expect(release).not.toHaveBeenCalled();
    },
  );

  it("does not retry a server-owned stale-attempt refusal", async () => {
    const release = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "configuration_adoption_stale",
            message: "The adoption attempt changed",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    stubServerApi({ "v1.threads.:id.configuration.release.$post": release });
    await expect(
      runCommand(
        [
          "thread",
          "release-configuration",
          "thread-retained",
          "--generation",
          "null",
          "--expected-provider-session",
          "native-retained",
          "--recover-adoption",
          "attempt-1",
          "--expected-native-context-json",
          "null",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(release).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "Error: HTTP 409: The adoption attempt changed",
    );
  });
});
