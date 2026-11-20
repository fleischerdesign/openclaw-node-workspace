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
