import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";

import { NodeWorkspaceError, errorMessage } from "./errors.js";

const SMALL_FILE_HASH_BYTES = 4 * 1024 * 1024;

/**
 * Hash one regular file and prove it did not change during the read.
 *
 * The before/after stat is not a whole-tree snapshot; it only prevents a file
 * that is being rewritten from entering a manifest with a stale digest.
 */
export async function hashRegularFile(
  absolutePath: string,
): Promise<{ size: number; sha256: string }> {
  const before = await fs.lstat(absolutePath);
  if (!before.isFile()) {
    throw new NodeWorkspaceError("special-file-rejected", `not a regular file: ${absolutePath}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    if (before.size <= SMALL_FILE_HASH_BYTES) {
      const content = await fs.readFile(absolutePath);
      bytes = content.byteLength;
      hash.update(content);
    } else {
      const stream = createReadStream(absolutePath);
      for await (const chunk of stream) {
        const buffer = chunk as Buffer;
        bytes += buffer.byteLength;
        hash.update(buffer);
      }
    }
  } catch (error) {
    throw new NodeWorkspaceError("io", `failed to read ${absolutePath}: ${errorMessage(error)}`, {}, { cause: error });
  }
  const after = await fs.lstat(absolutePath);
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino ||
    after.ctimeMs !== before.ctimeMs ||
    bytes !== before.size
  ) {
    throw new NodeWorkspaceError("io", `file changed while it was being read: ${absolutePath}`);
  }
  return { size: bytes, sha256: hash.digest("hex") };
}
