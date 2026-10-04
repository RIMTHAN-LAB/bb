import {
  readNativeProtectedFile,
  validateNativeHome,
} from "./native-protected-files.js";
import { nativeContextSchema, type NativeContext } from "@bb/domain";
import { z } from "zod";

const entry = z
  .object({ name: z.string().min(1).max(128), value: z.string().max(16_384) })
  .strict();
const stdio = z
  .object({
    name: z.string().min(1).max(128),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(128),
    env: z.array(entry).max(128),
  })
  .strict();
const remote = z
  .object({
    name: z.string().min(1).max(128),
    type: z.enum(["http", "sse"]),
    url: z.url().max(4096),
    headers: z.array(entry).max(128),
  })
  .strict();
const config = z
  .object({ servers: z.array(z.union([stdio, remote])).max(32) })
  .strict()
  .refine(
    (value) =>
      new Set(value.servers.map((server) => server.name)).size ===
      value.servers.length,
    "MCP server names must be unique",
  );
export type NativeAcpMcpServer = z.infer<typeof config>["servers"][number];

export async function readNativeMcpConfig(
  nativeContext: NativeContext | undefined,
  capabilities: { http?: boolean; sse?: boolean } | undefined,
): Promise<NativeAcpMcpServer[]> {
  if (nativeContext === undefined) return [];
  await validateNativeHome(nativeContext);
  if (nativeContext.mcpConfig === undefined) return [];
  const context = nativeContextSchema.parse(nativeContext);
  const reference = context.mcpConfig!;
  const bytes = await readNativeProtectedFile(context, reference, 65_536);
  const parsed = config.parse(JSON.parse(bytes.toString("utf8")));
  for (const server of parsed.servers) {
    if (server.name === "bb-bridge")
      throw new Error(
        "Native MCP config cannot replace BB's authenticated tool bridge",
      );
    if ("type" in server && capabilities?.[server.type] !== true)
      throw new Error(
        `ACP provider does not advertise native MCP ${server.type} transport`,
      );
  }
  return parsed.servers;
}
