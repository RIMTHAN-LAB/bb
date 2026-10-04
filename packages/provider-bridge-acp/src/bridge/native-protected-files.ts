import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { NativeContext } from "@bb/domain";

export async function validateNativeHome(
  context: NativeContext,
): Promise<void> {
  const actualHome = await realpath(context.homePath);
  if (
    actualHome !== context.homePath ||
    !(await stat(actualHome)).isDirectory()
  )
    throw new Error("Native home must be an existing canonical directory");
}

export async function readNativeProtectedFile(
  context: NativeContext,
  reference: { path: string; sha256: string },
  maximumBytes: number,
): Promise<Buffer> {
  await validateNativeHome(context);
  const [actualHome, actualPath] = await Promise.all([
    realpath(context.homePath),
    realpath(reference.path),
  ]);
  if (!actualPath.startsWith(actualHome + "/") || actualPath !== reference.path)
    throw new Error(
      "Native configuration must be a regular file inside the exact native home",
    );
  const file = await open(
    reference.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > maximumBytes ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error(
        "Native configuration must be an owner-only bounded regular file",
      );
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const content = bytes.subarray(0, length);
    if (
      content.length > maximumBytes ||
      createHash("sha256").update(content).digest("hex") !== reference.sha256
    )
      throw new Error(
        "Native configuration digest does not match the exact thread reference",
      );
    return content;
  } finally {
    await file.close();
  }
}
