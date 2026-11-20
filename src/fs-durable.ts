import fs from "node:fs/promises";

import { NodeWorkspaceError, errorMessage, isErrno } from "./errors.js";

/**
 * fsync one directory so its entries are durable.
 *
 * Some filesystems reject directory fsync; that is not a durability failure the
 * plugin can fix. Anything else is reported, because claiming a committed
 * update after a failed sync would be dishonest.
 */
export async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isErrno(error, "EINVAL", "ENOTSUP", "EBADF")) {
      throw new NodeWorkspaceError("io", `cannot sync directory ${directory}: ${errorMessage(error)}`, {}, {
        cause: error,
      });
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Write every byte even when the handle reports a short write. */
export async function writeAllBytes(
  handle: { write(buffer: Uint8Array, offset?: number, length?: number): Promise<{ bytesWritten: number }> },
  body: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < body.byteLength) {
    const { bytesWritten } = await handle.write(body.subarray(offset), 0, body.byteLength - offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new NodeWorkspaceError("io", "short write made no progress");
    }
    offset += bytesWritten;
  }
}
