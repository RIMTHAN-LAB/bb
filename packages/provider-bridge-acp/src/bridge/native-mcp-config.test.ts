import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readNativeMcpConfig } from "./native-mcp-config.js";

async function withConfig(
  value: unknown,
  run: (context: {
    homePath: string;
    mcpConfig: { path: string; sha256: string };
  }) => Promise<void>,
) {
  const homePath = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "bb-native-mcp-")),
  );
  const configPath = path.join(homePath, "mcp.json");
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(configPath, bytes, { mode: 0o600 });
  try {
    await run({
      homePath,
      mcpConfig: {
        path: configPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
}

const stdio = {
  name: "native-local",
  command: "/usr/bin/printf",
  args: [],
  env: [{ name: "LOCAL_SECRET", value: "private-local-value" }],
};

describe("protected native MCP configuration", () => {
  it("loads stdio locally and admits only negotiated remote transports", async () => {
    const http = {
      name: "native-http",
      type: "http",
      url: "http://127.0.0.1:40123/mcp",
      headers: [{ name: "Authorization", value: "local-value" }],
    };
    await withConfig({ servers: [stdio, http] }, async (context) => {
      await expect(readNativeMcpConfig(context, undefined)).rejects.toThrow(
        "does not advertise",
      );
      expect(await readNativeMcpConfig(context, { http: true })).toEqual([
        stdio,
        http,
      ]);
    });
  });
  it("rejects changed bytes, public permissions, symlinks, and unknown fields", async () => {
    await withConfig({ servers: [stdio] }, async (context) => {
      const homeAlias = context.homePath + "-alias";
      await symlink(context.homePath, homeAlias);
      try {
        await expect(
          readNativeMcpConfig({ homePath: homeAlias }, undefined),
        ).rejects.toThrow("canonical directory");
      } finally {
        await rm(homeAlias);
      }
      await expect(
        readNativeMcpConfig(
          {
            ...context,
            mcpConfig: { ...context.mcpConfig, sha256: "0".repeat(64) },
          },
          undefined,
        ),
      ).rejects.toThrow("digest");
      await chmod(context.mcpConfig.path, 0o644);
      await expect(readNativeMcpConfig(context, undefined)).rejects.toThrow(
        "owner-only",
      );
      await chmod(context.mcpConfig.path, 0o600);
      const alias = path.join(context.homePath, "alias.json");
      await symlink(context.mcpConfig.path, alias);
      await expect(
        readNativeMcpConfig(
          { ...context, mcpConfig: { ...context.mcpConfig, path: alias } },
          undefined,
        ),
      ).rejects.toThrow("regular file");
    });
    await withConfig(
      { servers: [{ ...stdio, ignoredSecretSource: "/tmp/ignored" }] },
      async (context) => {
        await expect(readNativeMcpConfig(context, undefined)).rejects.toThrow();
      },
    );
  });
});
