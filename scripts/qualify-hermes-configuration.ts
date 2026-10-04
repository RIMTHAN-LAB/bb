import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { build } from "esbuild";
import { createAgentRuntime } from "../packages/agent-runtime/src/index.js";
import type {
  AgentRuntimeBridgeLaunch,
  StartThreadResult,
} from "../packages/agent-runtime/src/index.js";

const hermesRoot = await fs.realpath(process.argv[2] ?? "");
const pythonPath = path.resolve(process.argv[3] ?? "");
const outputPath = path.resolve(
  process.argv[4] ?? "/tmp/bb-hermes-configuration-evidence.json",
);
const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "bb-hermes-qualification-")),
);
const workspacePath = path.join(directory, "team");
await fs.mkdir(workspacePath);
const artifactPath = path.join(directory, "acp-bridge.mjs");
await build({
  entryPoints: ["packages/provider-bridge-acp/src/bridge/bridge.ts"],
  outfile: artifactPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["source"],
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);",
  },
});
const artifactDigest = createHash("sha256")
  .update(await fs.readFile(artifactPath))
  .digest("hex");
const fixturePath = path.join(directory, "native_mcp_fixture.py");
await fs.writeFile(
  fixturePath,
  `import sys\nfrom mcp.server.mcpserver import MCPServer\nmcp=MCPServer('configuration-qualification')\n@mcp.tool()\ndef native_ping(marker:str='qualification')->str:\n    return marker\nif sys.argv[1]=='stdio':\n    mcp.run(transport='stdio')\nelse:\n    import uvicorn\n    from starlette.middleware.base import BaseHTTPMiddleware\n    from starlette.responses import PlainTextResponse\n    app=mcp.sse_app() if sys.argv[1]=='sse' else mcp.streamable_http_app()\n    class Auth(BaseHTTPMiddleware):\n        async def dispatch(self,request,call_next):\n            if request.headers.get('authorization')!='Bearer qualification-local':\n                return PlainTextResponse('unauthorized',status_code=401)\n            return await call_next(request)\n    app.add_middleware(Auth)\n    uvicorn.run(app,host='127.0.0.1',port=int(sys.argv[2]),log_level='warning')\n`,
);
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No local port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
const ports = await Promise.all([port(), port()]);
const childEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: directory,
  PYTHONPATH: hermesRoot,
  PYTHONUNBUFFERED: "1",
};
const fixtureProcesses = ["http", "sse"].map((transport, index) =>
  spawn(pythonPath, [fixturePath, transport, String(ports[index])], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  }),
);
const fixtureErrors: string[] = [];
for (const child of fixtureProcesses)
  child.stderr?.on("data", (bytes) =>
    fixtureErrors.push(String(bytes).slice(-2000)),
  );
const events: unknown[] = [];
const runtimeErrors: string[] = [];
const runtimes = [0, 1, 2, 3].map(() =>
  createAgentRuntime({
    workspacePath,
    shellEnv: childEnv,
    env: childEnv,
    onEvent: (event) => events.push(event),
    onStderr: (line) => runtimeErrors.push(line.slice(-2000)),
  }),
);
const launch: AgentRuntimeBridgeLaunch = {
  pluginId: "hermes-qualification",
  dataDir: directory,
  source: { kind: "artifact", digest: artifactDigest, artifactPath },
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
  },
  providerOptions: {},
  envPassthrough: [],
};
const commonInstructions =
  "Read the exact selected native skills and preserve the managed profile.";
const hashes: string[] = [];
async function protectedFile(homePath: string, name: string, body: string) {
  const filePath = path.join(homePath, name);
  await fs.writeFile(filePath, body, { mode: 0o600 });
  return {
    path: filePath,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}
let phase = "native-profile-preflight";
const results: StartThreadResult[] = [];
const startArgs: Parameters<(typeof runtimes)[number]["startThread"]>[0][] = [];
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [http, sse] = await Promise.all([
        fetch(`http://127.0.0.1:${ports[0]}/mcp`),
        fetch(`http://127.0.0.1:${ports[1]}/sse`),
      ]);
      if (http.status === 401 && sse.status === 401) break;
    } catch {}
    if (attempt === 99)
      throw new Error(
        `Native MCP fixture startup failed: ${fixtureErrors.join("\n")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (let index = 0; index < 4; index++) {
    const profile = [0, 1, 0, 2][index];
    const homePath = path.join(directory, `home-${profile}`);
    for (const subdir of [
      "cron",
      "sessions",
      "logs/curator",
      "memories",
      "pairing",
      "hooks",
      "image_cache",
      "audio_cache",
      "skills",
    ])
      await fs.mkdir(path.join(homePath, subdir), {
        recursive: true,
        mode: 0o700,
      });
    const skillsPath = path.join(
      homePath,
      ".factory-managed",
      "package",
      "exact-skill",
    );
    await fs.mkdir(path.join(skillsPath, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillsPath, "SKILL.md"),
      `---\nname: exact-skill\ndescription: Exact selected native skill\n---\nrevision-${profile}\n`,
    );
    await fs.writeFile(
      path.join(skillsPath, "references", "detail.md"),
      `reference-revision-${profile}\n`,
    );
    await fs.writeFile(
      path.join(homePath, "config.yaml"),
      JSON.stringify({
        model: { default: "qualification", provider: "openai" },
        platform_toolsets: { acp: ["skills"] },
        skills: { plugin_dirs: [path.dirname(skillsPath)] },
        agent: { max_turns: 1 },
      }),
    );
    const instructionsConfig = await protectedFile(
      homePath,
      `native-instructions-${index}.txt`,
      "full native base " +
        String(index) +
        "\n" +
        "bounded instruction material\n".repeat(300),
    );
    const mcpConfig = await protectedFile(
      homePath,
      `native-mcp-${index}.json`,
      JSON.stringify({
        servers: [
          {
            name: "native-stdio",
            command: pythonPath,
            args: [fixturePath, "stdio"],
            env: [],
          },
          {
            name: "native-http",
            type: "http",
            url: `http://127.0.0.1:${ports[0]}/mcp`,
            headers: [
              {
                name: "Authorization",
                value:
                  index === 3
                    ? "Bearer rejected-local"
                    : "Bearer qualification-local",
              },
            ],
          },
          {
            name: "native-sse",
            type: "sse",
            url: `http://127.0.0.1:${ports[1]}/sse`,
            headers: [
              { name: "Authorization", value: "Bearer qualification-local" },
            ],
          },
        ],
      }),
    );
    const nativeContext = { homePath, mcpConfig, instructionsConfig };
    const args: Parameters<(typeof runtimes)[number]["startThread"]>[0] = {
      environmentId: "same-team",
      projectId: "qualification",
      threadId: `recipient-${index}`,
      providerId: "acp-hermes",
      bridgeLaunch: launch,
      instructions: commonInstructions,
      dynamicTools: [
        {
          name: `recipient_tool_${index}`,
          description: "Exact recipient tool discovery qualification",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      options: {
        model: "qualification",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        providerOptions: {
          acpConfigurationGeneration: index + 1,
          acpNativeContext: nativeContext,
          acpLaunchSpec: {
            displayName: "Hermes source qualification",
            command: pythonPath,
            args: ["-m", "acp_adapter.entry"],
            cwd: hermesRoot,
            env: {
              ...childEnv,
              HERMES_HOME: homePath,
              OPENAI_API_KEY: "qualification-unused",
              OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
            },
          },
        },
      },
    };
    startArgs.push(args);
    const result = await runtimes[index]!.startThread(args);
    if (index === 3) {
      if (
        result.providerReadback?.nativeMcp.status !== "observed" ||
        result.providerReadback.nativeMcp.servers.find(
          (server) => server.name === "native-http",
        )?.status !== "failed"
      )
        throw new Error(
          "Authenticated native MCP failure was not observed fail closed",
        );
      results.push(result);
      continue;
    }
    if (
      !result.providerInstanceId ||
      result.providerReadback?.instructions.status !== "observed" ||
      result.providerReadback.nativeInstructions.status !== "observed" ||
      result.providerReadback.tools.status !== "observed" ||
      result.providerReadback.skills.status !== "observed" ||
      result.providerReadback.nativeMcp.status !== "observed"
    )
      throw new Error(
        "Actual provider did not acknowledge every required configuration capability",
      );
    const skill = result.providerReadback.skills.skills.find(
      (skill) => skill.name === "exact-skill",
    );
    if (
      skill?.origin !== "plugin" ||
      !skill.filePath.startsWith(homePath + "/") ||
      result.providerReadback.nativeInstructions.nativeInstructionsDigest !==
        instructionsConfig.sha256 ||
      !result.providerReadback.tools.toolNames.includes(
        `recipient_tool_${index}`,
      )
    )
      throw new Error(
        "Exact native profile readback differs from expected configuration",
      );
    for (const name of ["native-stdio", "native-http", "native-sse"]) {
      const server = result.providerReadback.nativeMcp.servers.find(
        (server) => server.name === name,
      );
      if (
        server?.transport !== name.replace("native-", "") ||
        server?.status !== "connected" ||
        !server.toolNames.includes("native_ping") ||
        !server.schemaDigest
      )
        throw new Error(`Native MCP protocol discovery not observed: ${name}`);
    }
    hashes.push(skill.contentDigest);
    results.push(result);
  }
  if (
    hashes[0] === hashes[1] ||
    hashes[0] !== hashes[2] ||
    new Set(results.map((result) => result.providerInstanceId)).size !==
      results.length
  )
    throw new Error("Recipient profiles were not isolated");
  phase = "native-session-resume";
  const first = startArgs[0]!;
  const firstResult = results[0]!;
  const home = (
    first.options.providerOptions!.acpNativeContext as { homePath: string }
  ).homePath;
  await runtimes[0]!.stopThread({ threadId: first.threadId });
  await promisify(execFile)(
    pythonPath,
    [
      "-c",
      "from pathlib import Path;import sys;from hermes_state import SessionDB;db=SessionDB(Path(sys.argv[1])/'state.db');assert db.get_session(sys.argv[2]) is not None;db.append_message(sys.argv[2],role='user',content='trusted historical continuity fixture');db.close()",
      home,
      firstResult.providerThreadId,
    ],
    {
      cwd: hermesRoot,
      env: { ...childEnv, HERMES_HOME: home },
      timeout: 20000,
    },
  );
  const renewedInstructions = await protectedFile(
    home,
    "native-instructions-renewed.txt",
    "renewed preserved-conversation native base\n" +
      "bounded instruction material\n".repeat(300),
  );
  const previousNative = first.options.providerOptions!.acpNativeContext as {
    homePath: string;
    mcpConfig: { path: string; sha256: string };
  };
  const renewed = await runtimes[0]!.resumeThread({
    ...first,
    providerThreadId: firstResult.providerThreadId,
    options: {
      ...first.options,
      providerOptions: {
        ...first.options.providerOptions,
        acpConfigurationGeneration: 10,
        acpNativeContext: {
          ...previousNative,
          instructionsConfig: renewedInstructions,
        },
      },
    },
  });
  if (
    renewed.providerThreadId !== firstResult.providerThreadId ||
    !renewed.providerInstanceId ||
    renewed.providerInstanceId === firstResult.providerInstanceId ||
    renewed.providerReadback?.nativeInstructions.status !== "observed" ||
    renewed.providerReadback.nativeInstructions.nativeInstructionsDigest !==
      renewedInstructions.sha256
  )
    throw new Error(
      "Exact native conversation resume/reconfigure did not acknowledge its new provider instance",
    );
  const expectedHistoryDigest = createHash("sha256")
    .update(
      JSON.stringify([
        { content: "trusted historical continuity fixture", role: "user" },
      ]),
    )
    .digest("hex");
  const history = renewed.providerReadback.nativeConversation;
  const historyFixtureObserved =
    history?.status === "observed" &&
    history.messageCount === 1 &&
    history.historyDigest === expectedHistoryDigest;
  if (!historyFixtureObserved)
    throw new Error(
      "Persisted historical fixture was not observed in the actual loaded native session state",
    );
  await runtimes[0]!.stopThread({ threadId: first.threadId });
  phase = "missing-session-refusal";
  let missingSessionRefused = false;
  try {
    await runtimes[0]!.resumeThread({
      ...first,
      providerThreadId: "missing-managed-native-session",
    });
  } catch (error) {
    missingSessionRefused =
      String(error).includes("restore failed") ||
      String(error).includes("Native session not found");
  }
  if (!missingSessionRefused)
    throw new Error(
      "Managed restore silently replaced a missing native conversation",
    );
  const continuity = {
    qualification: "fixture-seeded-native-conversation-resume",
    historicalFixtureSeededLocally: true,
    historyFixtureObserved,
    historyDigest: expectedHistoryDigest,
    modelDispatched: false,
    missingSessionRefused,
    providerSessionId: renewed.providerThreadId,
    oldProviderInstanceId: firstResult.providerInstanceId,
    renewedProviderInstanceId: renewed.providerInstanceId,
    renewedNativeInstructionsDigest: renewedInstructions.sha256,
  };
  const modelEvents = events.filter((event) =>
    [
      "turn/started",
      "item/agentMessage/delta",
      "item/toolCall/started",
    ].includes((event as { type: string }).type),
  );
  if (modelEvents.length > 0)
    throw new Error("Preparation dispatched a model turn");
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        qualification: "real-native-provider-preflight",
        modelDispatched: false,
        sameWorkspace: workspacePath,
        provider: "acp-hermes",
        hermesRoot,
        artifactDigest,
        profileSequence: [0, 1, 0],
        authenticationFailureObserved: true,
        continuity,
        results,
        eventsCount: events.length,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({
      outputPath,
      profiles: results.length,
      observedTransports: ["stdio", "http", "sse"],
      modelDispatched: false,
    }) + "\n",
  );
} catch (error) {
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        qualification: "failed",
        phase,
        completedProfiles: results.length,
        exactTransportProfiles: hashes.length,
        error: error instanceof Error ? error.message : String(error),
        runtimeErrors,
        fixtureErrors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const runtime of runtimes) await runtime.shutdown();
  for (const child of fixtureProcesses) child.kill("SIGTERM");
  await fs.rm(directory, { recursive: true, force: true });
}
