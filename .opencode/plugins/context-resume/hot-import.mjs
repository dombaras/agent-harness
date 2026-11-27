/*
 * hot-import — evaluate a local ESM module from disk through a cache-busting
 * file URL (F-064).
 *
 * The TUI plugin loader caches its module graph for the process lifetime: a
 * deployed fix to a statically imported helper is invisible to a running TUI,
 * and a broken helper makes the whole plugin fail to LOAD (`plugin operation
 * failed`), which never retries. `tui.tsx` therefore imports only this tiny
 * plumbing module statically and evaluates the decision module (`resume-plan.mjs`)
 * through `importFresh` on every execution end: a deploy is picked up on the
 * next event, and an import error surfaces as a toast instead of a dead plugin.
 *
 * The stamp is the file's mtime + size. A missing file keeps the plain URL so
 * the import fails with its own error (the caller reports it).
 */
import fs from "node:fs"
import { fileURLToPath } from "node:url"

export function freshUrl(specifier, base = import.meta.url) {
  const url = new URL(specifier, base)
  let stamp = ""
  try {
    const stat = fs.statSync(fileURLToPath(url))
    stamp = `?v=${Math.floor(stat.mtimeMs)}-${stat.size}`
  } catch {
    /* missing file: let import() produce the error */
  }
  return url.href + stamp
}

export async function importFresh(specifier, base = import.meta.url) {
  return import(freshUrl(specifier, base))
}
