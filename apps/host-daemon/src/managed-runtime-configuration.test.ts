import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentRuntime,
  type AgentRuntimeOptions,
} from "@bb/agent-runtime";
import {
  createScriptedEchoLaunch,
  createScriptedEchoRequestRecord,
} from "@bb/agent-runtime/test";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";

const execution = {
  model: "test-model",
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

async function source(
  root: string,
  revision: string,
): Promise<HostDaemonInjectedSkillSource> {
  const sourceRootPath = path.join(root, revision);
  await fs.mkdir(sourceRootPath, { recursive: true });
  const skillFilePath = path.join(sourceRootPath, "SKILL.md");
  await fs.writeFile(
    skillFilePath,
    `---\nname: exact-package\ndescription: Exact package runtime isolation test\n---\n\n${revision}\n`,
  );
  return {
    kind: "workspace-path",
    sourceType: "project",
    name: "exact-package",
    description: "Exact package runtime isolation test",
    sourceRootPath,
    skillFilePath,
  };
}

describe("managed recipient runtime isolation", () => {
  it("runs simultaneous real bridge processes with different catalogs in one environment and preserves the sibling across a quiesced replacement", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "bb-managed-runtime-"),
    );
    const workspacePath = path.join(root, "team");
    await fs.mkdir(workspacePath);
    const oldSource = await source(root, "package-v1");
    const newSource = await source(root, "package-v2");
    const record = createScriptedEchoRequestRecord();
    const options: AgentRuntimeOptions[] = [];
    const manager = new RuntimeManager({
      dataDir: path.join(root, "daemon"),
      shellEnv: Object.fromEntries(
        Object.entries({ ...process.env, ...record.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      createRuntime: (args) => {
        options.push(args);
        return createAgentRuntime({
          ...args,
          env: { ...args.env, ...record.env },
        });
      },
    });
    const bridgeLaunch = createScriptedEchoLaunch({
      scripted: { swallowTurnStart: true },
    });
    const common = { environmentId: "team-environment", workspacePath };
    try {
      const [oldEntry, newEntry] = await Promise.all([
        manager.ensureEnvironment({
          ...common,
          targetThreadId: "recipient-old",
          nativeContext: { homePath: path.join(root, "old-home") },
          configurationGeneration: 1,
          injectedSkillSources: [oldSource],
        }),
        manager.ensureEnvironment({
          ...common,
          targetThreadId: "recipient-new",
          nativeContext: { homePath: path.join(root, "new-home") },
          configurationGeneration: 2,
          injectedSkillSources: [newSource],
        }),
      ]);
      expect(oldEntry.runtime).not.toBe(newEntry.runtime);
      expect(oldEntry.environmentId).toBe(common.environmentId);
      expect(newEntry.environmentId).toBe(common.environmentId);
      expect(oldEntry.path).toBe(newEntry.path);
      expect(oldEntry.skillCatalogHash).not.toBe(newEntry.skillCatalogHash);
      await Promise.all([
        oldEntry.runtime.startThread({
          bridgeLaunch,
          environmentId: common.environmentId,
          threadId: "recipient-old",
          projectId: "project",
          providerId: "scripted-echo",
          options: execution,
        }),
        newEntry.runtime.startThread({
          bridgeLaunch,
          environmentId: common.environmentId,
          threadId: "recipient-new",
          projectId: "project",
          providerId: "scripted-echo",
          options: execution,
        }),
      ]);
      expect(oldEntry.runtime.listRunningProviders()).toHaveLength(1);
      expect(newEntry.runtime.listRunningProviders()).toHaveLength(1);
      expect(
        record.read().filter((request) => request.method === "thread/start"),
      ).toHaveLength(2);
      const roots = options.flatMap((option) => option.skillRoots ?? []);
      expect(roots).toHaveLength(2);
      const bytes = await Promise.all(
        roots.map((skill) =>
          fs.readFile(
            path.join(skill.path, "exact-package", "SKILL.md"),
            "utf8",
          ),
        ),
      );
      expect(bytes.some((value) => value.includes("package-v1"))).toBe(true);
      expect(bytes.some((value) => value.includes("package-v2"))).toBe(true);
      await oldEntry.runtime.runTurn({
        clientRequestId: "creq_222222223u",
        threadId: "recipient-old",
        input: [
          {
            type: "text",
            text: "Wait for controlled quiescence",
            mentions: [],
          },
        ],
        options: execution,
      });
      const busy = await manager.ensureEnvironment({
        ...common,
        targetThreadId: "recipient-old",
        nativeContext: { homePath: path.join(root, "old-home") },
        configurationGeneration: 3,
        injectedSkillSources: [newSource],
      });
      expect(busy).toBe(oldEntry);
      expect(busy.configurationGeneration).toBe(1);
      await oldEntry.runtime.stopThread({ threadId: "recipient-old" });
      const replaced = await manager.ensureEnvironment({
        ...common,
        targetThreadId: "recipient-old",
        nativeContext: { homePath: path.join(root, "old-home") },
        configurationGeneration: 3,
        injectedSkillSources: [newSource],
      });
      expect(replaced.runtime).not.toBe(oldEntry.runtime);
      expect(replaced.configurationGeneration).toBe(3);
      expect(newEntry.runtime.hasThread("recipient-new")).toBe(true);
      expect(newEntry.runtime.listRunningProviders()).toHaveLength(1);
      expect(
        await manager.ensureEnvironment({
          ...common,
          targetThreadId: "recipient-new",
          nativeContext: { homePath: path.join(root, "new-home") },
          configurationGeneration: 2,
          injectedSkillSources: [newSource],
        }),
      ).toBe(newEntry);
      await manager.forgetEnvironment(common.environmentId);
      expect(manager.listLoadedEnvironments()).toEqual([]);
      expect(newEntry.runtime.listRunningProviders()).toHaveLength(0);
    } finally {
      await manager.shutdownAll();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(path.dirname(record.path), { recursive: true, force: true });
      await fs.rm(bridgeLaunch.dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
