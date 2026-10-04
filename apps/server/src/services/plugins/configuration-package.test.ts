import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigurationPackages } from "./configuration-package.js";
import type { PluginManifest } from "./manifest.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-configuration-package-")); roots.push(root);
  const plugin = join(root, "plugin"); await mkdir(join(plugin, "skills", "architect", "references"), { recursive: true });
  await writeFile(join(plugin, "skills", "architect", "SKILL.md"), "---\nname: architect\n---\nRead references/check.md.\n");
  await writeFile(join(plugin, "skills", "architect", "references", "check.md"), "Pinned architecture checklist.\n");
  const manifest = { id: "qualification", version: "1.0.0", rootDir: plugin, skillsRootPaths: [join(plugin, "skills")], skillNames: ["architect"] } as PluginManifest;
  let installed: PluginManifest | undefined = manifest;
  const service = new ConfigurationPackages(join(root, "data"), async () => installed);
  return { root, plugin, manifest, service, setInstalled: (next: PluginManifest | undefined) => { installed = next; } };
}
describe("immutable configuration package content", () => {
  it("exports deterministic referenced-file bytes and keeps the old pin after source replacement/uninstall", async () => {
    const f = await fixture(), reference = { pluginId: "qualification", version: "1.0.0", kind: "skill" as const };
    const first = await f.service.read(reference);
    expect(first.info.fileCount).toBe(2); expect(first.info.skillNames).toEqual(["architect"]);
    expect(first.info.digest).toBe(createHash("sha256").update(first.bytes).digest("hex"));
    expect((await f.service.read(reference)).bytes).toEqual(first.bytes);
    expect(first.bytes.toString()).toContain("architect/references/check.md"); expect(first.bytes.toString()).toContain("Pinned architecture checklist.");
    await writeFile(join(f.plugin, "skills", "architect", "references", "check.md"), "Changed content.\n");
    const changed = await f.service.read(reference); expect(changed.info.digest).not.toBe(first.info.digest);
    f.setInstalled(undefined);
    expect((await f.service.read({ ...reference, digest: first.info.digest })).bytes).toEqual(first.bytes);
    await expect(f.service.read({ ...reference, digest: "a".repeat(64) })).rejects.toThrow("unavailable");
  });
  it("refuses wrong versions/digests, path traversal, symlinks and duplicate skill names", async () => {
    const f = await fixture(), reference = { pluginId: "qualification", version: "1.0.0", kind: "skill" as const };
    await expect(f.service.read({ ...reference, version: "2.0.0" })).rejects.toThrow("version");
    await expect(f.service.read({ ...reference, digest: "f".repeat(64) })).rejects.toThrow("digest");
    await expect(f.service.read({ ...reference, pluginId: "../qualification" })).rejects.toThrow("reference");
    await symlink(join(f.root, "outside"), join(f.plugin, "skills", "architect", "escape"));
    await expect(f.service.read(reference)).rejects.toThrow("symbolic links");
    await rm(join(f.plugin, "skills", "architect", "escape"));
    f.manifest.skillsRootPaths.push(join(f.plugin, "skills"));
    await expect(f.service.read(reference)).rejects.toThrow("conflicting");
  });
  it("exports only the explicit native package subtree and verifies retained bytes on every exact read", async () => {
    const f = await fixture(); await mkdir(join(f.plugin, "mcp"));
    await writeFile(join(f.plugin, "mcp", "mcp.json"), JSON.stringify({ transport: "stdio", command: "server.sh", args: [] }));
    await writeFile(join(f.plugin, "mcp", "server.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(f.plugin, "secret-local-config"), "must stay out");
    const reference = { pluginId: "qualification", version: "1.0.0", kind: "mcp" as const };
    const result = await f.service.read(reference); expect(result.bytes.toString()).not.toContain("must stay out"); expect(result.info.fileCount).toBe(2);
    const cache = join(f.root, "data", "configuration-packages", result.info.digest + ".tar");
    expect(await readFile(cache)).toEqual(result.bytes); await writeFile(cache, "tampered");
    await expect(f.service.read({ ...reference, digest: result.info.digest })).rejects.toThrow("differs");
  });
  it("repairs an interrupted orphan before publishing an inspected exact pin", async () => {
    const f = await fixture(), reference = { pluginId: "qualification", version: "1.0.0", kind: "skill" as const };
    const first = await f.service.read(reference);
    const cache = join(f.root, "data", "configuration-packages");
    const metadata = (await readdir(cache)).find((name) => name.endsWith(".json"))!;
    await rm(join(cache, metadata));
    await writeFile(join(cache, first.info.digest + ".tar"), "interrupted");
    const inspected = await f.service.read(reference);
    expect(inspected.info.digest).toBe(first.info.digest);
    f.setInstalled(undefined);
    expect((await f.service.read({ ...reference, digest: inspected.info.digest })).bytes).toEqual(first.bytes);
    expect((await readdir(cache)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("bounds retained metadata and tar files before reading their content", async () => {
    const f = await fixture(), reference = { pluginId: "qualification", version: "1.0.0", kind: "skill" as const };
    const first = await f.service.read(reference);
    const cache = join(f.root, "data", "configuration-packages");
    const metadata = (await readdir(cache)).find((name) => name.endsWith(".json"))!;
    const handle = await open(join(cache, metadata), "r+");
    await handle.truncate((64 << 10) + 1); await handle.close();
    await expect(f.service.read({ ...reference, digest: first.info.digest })).rejects.toThrow("bound");
    await f.service.read(reference);
    const tar = await open(join(cache, first.info.digest + ".tar"), "r+");
    await tar.truncate((16 << 20) + 1); await tar.close();
    await expect(f.service.read({ ...reference, digest: first.info.digest })).rejects.toThrow("bound");
  });
  it("rejects an oversized directory inventory without traversing it", async () => {
    const f = await fixture(), reference = { pluginId: "qualification", version: "1.0.0", kind: "skill" as const };
    for (let n = 0; n < 256; n++) await writeFile(join(f.plugin, "skills", "architect", "references", "entry-" + n), "x");
    await expect(f.service.read(reference)).rejects.toThrow("bound");
  });
});
