#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { parseBacklog } from "../src/lib/import";
import { importBoard } from "../src/lib/importer";
import { prisma } from "../src/lib/db";

/**
 * Import a legacy `BACKLOG.md` into the board service (ADR 0001 §9).
 *   tsx scripts/migrate-board.ts --root <dir> [--project <key>] [--name <label>]
 */
async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : args[i + 1];
  };
  const root = path.resolve(get("--root", process.cwd()) ?? process.cwd());
  const file = path.join(root, "BACKLOG.md");
  if (!fs.existsSync(file)) {
    console.error(`migrate-board: no BACKLOG.md at ${file}`);
    process.exit(1);
  }
  const project = get("--project", path.basename(root))!;
  const name = get("--name", project)!;
  const parsed = parseBacklog(project, fs.readFileSync(file, "utf8"));
  parsed.project = project;
  const summary = await importBoard(parsed, { projectName: name });
  console.log(
    `migrate-board: ${project} — ${summary.open} open · ${summary.queued} queued · ${summary.inprogress} in-progress · ` +
      `${summary.frozen} frozen · ${summary.archive} archived · ${summary.epics} epics`
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(`migrate-board: ${error instanceof Error ? error.message : error}`);
  await prisma.$disconnect();
  process.exit(1);
});
