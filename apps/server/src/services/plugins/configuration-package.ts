import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import type { PluginManifest } from "./manifest.js";

const MAX_BYTES = 16 << 20;
const MAX_FILES = 256;
const MAX_EXPORTS = 4096;
export type ConfigurationPackageKind = "skill" | "mcp";
export type ConfigurationPackageRequest = { pluginId: string; version: string; kind: ConfigurationPackageKind; digest?: string };
export type ConfigurationPackageInfo = { pluginId: string; version: string; kind: ConfigurationPackageKind; digest: string; byteLength: number; fileCount: number; skillNames: string[] };
export type ConfigurationPackageExport = { info: ConfigurationPackageInfo; bytes: Buffer };
type PackageFile = { path: string; bytes: Buffer; executable: boolean };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const component = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && value !== "." && value !== "..";

async function directoryNames(path: string, limit: number): Promise<string[]> {
  const names: string[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (names.length >= limit) throw new Error("configuration package directory exceeds entry bound");
    names.push(entry.name);
  }
  return names.sort();
}
async function boundedBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const storage = Buffer.alloc(size + 1);
  let length = 0;
  while (length < storage.length) {
    const { bytesRead } = await handle.read(storage, length, storage.length - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length !== size || (await handle.stat()).size !== size) throw new Error("configuration package file changed during bounded read");
  return storage.subarray(0, length);
}
async function cacheBytes(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > limit || current.size < 1) throw new Error("retained configuration package exceeds file bound");
    return await boundedBytes(handle, current.size);
  } finally { await handle.close(); }
}
async function publishCache(path: string, bytes: Buffer): Promise<void> {
  const temporary = path + "." + randomUUID() + ".tmp";
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    // Publish complete verified content atomically. A prior interrupted orphan
    // is repaired from the exact installed source instead of trusting EEXIST.
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

function field(header: Buffer, at: number, size: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > size) throw new Error("configuration package archive path exceeds USTAR bound");
  bytes.copy(header, at);
}
function octal(header: Buffer, at: number, size: number, value: number): void {
  field(header, at, size, value.toString(8).padStart(size - 1, "0") + "\0");
}
/** Stable USTAR bytes contain only admitted regular files: no timestamps, owners or host paths. */
function archive(files: PackageFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    let name = file.path, prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf("/");
      if (split < 0) throw new Error("configuration package archive path exceeds USTAR bound");
      prefix = name.slice(0, split); name = name.slice(split + 1);
    }
    const header = Buffer.alloc(512);
    field(header, 0, 100, name); octal(header, 100, 8, file.executable ? 0o755 : 0o644);
    octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, file.bytes.length); octal(header, 136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48;
    field(header, 257, 6, "ustar\0"); field(header, 263, 2, "00"); field(header, 345, 155, prefix);
    let checksum = 0; for (const byte of header) checksum += byte;
    field(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    parts.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const bytes = Buffer.concat(parts);
  if (bytes.length > MAX_BYTES) throw new Error("configuration package exceeds archive byte bound");
  return bytes;
}

async function packageFiles(manifest: PluginManifest, kind: ConfigurationPackageKind): Promise<PackageFile[]> {
  const root = await realpath(manifest.rootDir);
  const files: PackageFile[] = [];
  const seen = new Set<string>(); let total = 0, entries = 0;
  const visit = async (source: string, path: string, depth: number): Promise<void> => {
    if (depth > 16 || ++entries > MAX_FILES) throw new Error("configuration package exceeds file/depth bound");
    const st = await lstat(source);
    if (st.isSymbolicLink()) throw new Error("configuration package may not contain symbolic links");
    const canonical = await realpath(source);
    if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error("configuration package escapes the installed source");
    if (st.isDirectory()) {
      for (const entry of await directoryNames(source, MAX_FILES - entries)) await visit(join(source, entry), path ? path + "/" + entry : entry, depth + 1);
      return;
    }
    if (!st.isFile() || !path || /[\x00\r\n\\]/.test(path) || seen.has(path)) throw new Error("configuration package contains non-regular or conflicting files");
    if (st.size > MAX_BYTES || total + st.size > MAX_BYTES) throw new Error("configuration package exceeds expanded byte bound");
    const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.size !== st.size || current.ino !== st.ino || current.dev !== st.dev) throw new Error("configuration package source changed during read");
      bytes = await boundedBytes(handle, current.size);
    } finally { await handle.close(); }
    if (bytes.length !== st.size) throw new Error("configuration package source changed during read");
    total += bytes.length; seen.add(path); files.push({ path, bytes, executable: (st.mode & 0o111) !== 0 });
  };
  if (kind === "skill") {
    for (const skillsRoot of manifest.skillsRootPaths) {
      for (const name of manifest.skillNames) {
        const source = join(skillsRoot, name);
        try { await lstat(join(source, "SKILL.md")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        await visit(source, name, 0);
      }
    }
    if (files.length === 0) throw new Error("installed plugin has no exportable skill content");
  } else {
    // A native package is an explicit portable mcp/ subtree; server code, dependencies,
    // local configuration and plugin secrets are never swept into the archive.
    await visit(join(root, "mcp"), "", 0);
    if (!files.some((file) => file.path === "mcp.json")) throw new Error("installed plugin has no portable mcp/mcp.json descriptor");
  }
  return files;
}

/** Reuses installed BB package content; never installs, updates or starts a plugin. Retained
 * immutable exports permit old pinned recipients after a package update or uninstall. */
export class ConfigurationPackages {
  constructor(private readonly dataDir: string, private readonly installed: (id: string) => Promise<PluginManifest | undefined>) {}
  async read(request: ConfigurationPackageRequest): Promise<ConfigurationPackageExport> {
    if (!component(request.pluginId) || !component(request.version) || (request.kind !== "skill" && request.kind !== "mcp") || (request.digest !== undefined && !/^[a-f0-9]{64}$/.test(request.digest))) throw new Error("invalid exact configuration package reference");
    const cacheRoot = join(this.dataDir, "configuration-packages");
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(cacheRoot)).isSymbolicLink() || await realpath(cacheRoot) !== join(await realpath(this.dataDir), "configuration-packages")) throw new Error("configuration package cache may not be a symbolic link");
    const key = createHash("sha256").update(JSON.stringify([request.pluginId, request.version, request.kind])).digest("hex");
    if (request.digest !== undefined) {
      try {
        const meta: unknown = JSON.parse((await cacheBytes(join(cacheRoot, key + "." + request.digest + ".json"), 64 << 10)).toString("utf8"));
        const info = meta as ConfigurationPackageInfo;
        const bytes = await cacheBytes(join(cacheRoot, request.digest + ".tar"), MAX_BYTES);
        if (info.pluginId !== request.pluginId || info.version !== request.version || info.kind !== request.kind || info.digest !== request.digest || bytes.length > MAX_BYTES || info.byteLength !== bytes.length || hash(bytes) !== request.digest) throw new Error("retained package content differs from exact reference");
        return { info, bytes };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const manifest = await this.installed(request.pluginId);
    if (!manifest || manifest.id !== request.pluginId || manifest.version !== request.version) throw new Error("exact installed package version is unavailable");
    const files = await packageFiles(manifest, request.kind);
    const bytes = archive(files), digest = hash(bytes);
    if (request.digest !== undefined && request.digest !== digest) throw new Error("installed package content differs from approved digest");
    const info: ConfigurationPackageInfo = { pluginId: manifest.id, version: manifest.version, kind: request.kind, digest, byteLength: bytes.length, fileCount: files.length, skillNames: request.kind === "skill" ? [...manifest.skillNames].sort() : [] };
    const existing = await directoryNames(cacheRoot, MAX_EXPORTS * 2 + 64);
    const metaPath = join(cacheRoot, key + "." + digest + ".json");
    if (!existing.includes(key + "." + digest + ".json") && existing.filter((name) => name.endsWith(".json")).length >= MAX_EXPORTS) throw new Error("configuration package export capacity reached");
    await publishCache(join(cacheRoot, digest + ".tar"), bytes);
    await publishCache(metaPath, Buffer.from(JSON.stringify(info)));
    return { info, bytes };
  }
}
