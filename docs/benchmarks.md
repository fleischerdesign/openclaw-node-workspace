# Managed sync benchmark

Date: 2026-11-20. Reproduce with:

```bash
BENCH_OUT=/tmp/managed-bench.json npm run bench:managed
```

The script uses the real Gateway sync logic, real node handlers, the in-process framed channel and
real files on disk. Only the network hop is a test double. It is one run, not a statistical claim.

## Environment

| Property | Value |
| --- | --- |
| Host | `mob-nb-01` (paired node, 16 CPUs) |
| Platform | `linux 6.18.58 x64` |
| Node | `v24.22.2` |
| Fixture | 160 source files × 4096 B (655,360 B), one protected `.env` |
| Cache | 2,048 dependency files × 16,384 B (33,554,432 B), installed on the node after creation |
| Policy | preset `node` (excludes `node_modules`, `dist`, `.git`, common caches) |
| Peak RSS | 103,324 KiB |
| Report | [2026-11-20-mob-nb-01.json](benchmarks/2026-11-20-mob-nb-01.json) |

## Results

All times are milliseconds. `transferred` is the wire payload reported by the sync result.

| Scenario | Cache absent | Cache present (32 MiB) |
| --- | ---: | ---: |
| Cold preview | 183.78 | 139.01 |
| Cold apply | 423.22 | 381.38 |
| Cold transferred bytes | 654,570 | 654,570 |
| No-op apply, single | 246.78 | 236.92 |
| No-op apply, p50 of 5 | 231.09 | 229.50 |
| No-op transferred bytes | 0 | 0 |
| One-file update | 259.46 | 237.73 |
| One-file transferred bytes | 4,090 | 4,090 |
| Exact deletion apply | 247.69 | 242.17 |
| Deletion transferred bytes | 0 | 0 |
| Revision after deletion | 3 | 3 |
| Protected paths reported | 1 | 1 |

### Preservation

| Check | Cache absent | Cache present |
| --- | ---: | ---: |
| Node source files preserved after update/delete | 158 checked, 0 changed | 158 checked, 0 changed |
| Local source files preserved | 158 checked, 0 changed | 158 checked, 0 changed |
| Node dependency cache inode/mtime | — | 2,048 checked, 0 changed |
| Local dependency cache inode/mtime | — | 2,048 checked, 0 changed |
| Workspace files after deletion | 159 | 2,207 (32 MiB cache + 159 source) |

### Disk and transaction bound

| Property | Cache absent | Cache present |
| --- | ---: | ---: |
| Workspace bytes after deletion | 650,470 | 34,196,350 |
| Registry + journal state bytes | 23,230 | 23,234 |
| Sum of transferred payload plus deleted-backup bytes (upper bound) | 662,755 | 662,755 |
| Filesystem free delta over the whole run | 704,512 B | 42,704,896 B |

The free-space delta includes installing the 32 MiB cache in the present run. `writeUpperBoundBytes`
is a computed bound (transferred payload + retention of deleted bytes), not a sampled peak. Peak disk
also includes the registry and journal, which are tens of KiB.

## Incremental build smoke

A two-file TypeScript project was created and synced with policy `node`. `tsc --incremental` wrote
`dist/` and `dist/.tsbuildinfo` on the node, both outside the managed source set.

| Step | Result |
| --- | --- |
| Cold build | 724.65 ms |
| No-op sync, then build | 302.36 ms |
| One source edit, sync, then build | 315.08 ms |
| `dist/` untouched by the no-op sync | 3 files checked, 0 changed |
| `dist/` untouched by the edit sync | 3 files checked, 0 changed |
| Edited output changed after rebuild | yes |
| Unchanged output preserved (inode/mtime) | yes |
| Build smoke passed | yes |

The build times are a sanity check of cache preservation, not a performance target or a claim about
larger projects. The no-op sync did not delete or rewrite `dist`, `.tsbuildinfo` or the dependency
cache; the compiler could therefore reuse them.

## Rust incremental smoke

`rustc` is not installed on `mob-nb-01` (`command -v rustc` exits 1), so the optional no-crate
`rustc -C incremental` smoke was skipped and recorded as `rust.available = false`. No crates or
network access were added.

## Re-measurement note

These numbers were re-run after staged payload `sync()` was added before `close()` and before the
`end`-frame unknown-outcome ordering fix. The cold apply is slower than the earlier run, as expected
from the added durability work; no speed target is claimed.

## What this does and does not show

- Shows: unchanged files and the dependency cache keep inode and mtime; a one-file update transfers
  one file payload; deletion transfers no payload; a no-op transfers nothing and keeps the revision.
- Does not show: a sampled peak-disk high-water mark, multi-run variance, network behaviour, or
  behaviour under concurrent native `exec`. Those remain unmeasured.
