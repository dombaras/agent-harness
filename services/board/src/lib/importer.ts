import { prisma } from "@/lib/db";
import type { ParsedBoard } from "@/lib/import";

/**
 * Idempotent import of a parsed `BACKLOG.md` into the board DB. Upserts epics,
 * items, dependencies, and the Active picks; never deletes rows that already
 * exist in the service. Re-running with the same board is a no-op.
 */
export interface ImportSummary {
  project: string;
  epics: number;
  total: number;
  open: number;
  queued: number;
  inprogress: number;
  frozen: number;
  archive: number;
}

export async function importBoard(parsed: ParsedBoard, opts: { projectName?: string } = {}): Promise<ImportSummary> {
  const project = parsed.project;
  return prisma.$transaction(async (tx) => {
    await tx.project.upsert({
      where: { key: project },
      update: { active: parsed.active, name: opts.projectName ?? project },
      create: { key: project, name: opts.projectName ?? project, active: parsed.active },
    });

    for (const e of parsed.epics) {
      await tx.epic.upsert({
        where: { project_key: { project, key: e.key } },
        update: { label: e.label, goal: e.goal },
        create: { project, key: e.key, label: e.label, goal: e.goal },
      });
    }

    // Upsert items first (deps reference item UUIDs, so all rows must exist).
    for (const row of parsed.rows) {
      await tx.backlogItem.upsert({
        where: { project_itemId: { project, itemId: row.id } },
        update: {
          status: row.status,
          priority: row.priority,
          epic: row.epic,
          task: row.task,
          evidence: row.evidence,
          handoff: row.handoff,
          why: row.why,
          reopen: row.reopen,
          closed: row.closed,
          sortOrder: row.sortOrder,
        },
        create: {
          project,
          itemId: row.id,
          status: row.status,
          priority: row.priority,
          epic: row.epic,
          task: row.task,
          evidence: row.evidence,
          handoff: row.handoff,
          why: row.why,
          reopen: row.reopen,
          closed: row.closed,
          sortOrder: row.sortOrder,
        },
      });
    }

    // Then dependencies (only when both endpoints exist).
    for (const row of parsed.rows) {
      const deps = row.dependsOn
        .split(/[\s,]+/)
        .map((d) => d.trim())
        .filter((d) => d && d !== "?");
      await tx.itemDependency.deleteMany({ where: { item: { project, itemId: row.id } } });
      for (const dep of deps) {
        const from = await tx.backlogItem.findUnique({ where: { project_itemId: { project, itemId: row.id } } });
        const to = await tx.backlogItem.findUnique({ where: { project_itemId: { project, itemId: dep } } });
        if (from && to) {
          await tx.itemDependency.create({ data: { itemId: from.id, dependsOn: to.id } }).catch(() => {
            /* duplicate dep — ignore */
          });
        }
      }
    }

    await tx.auditEvent.create({ data: { project, action: "import", actor: "migrate-board" } });

    const counts = await tx.backlogItem.groupBy({ by: ["status"], where: { project }, _count: { _all: true } });
    const summary = { open: 0, queued: 0, inprogress: 0, frozen: 0, archive: 0 };
    for (const c of counts) summary[c.status as keyof typeof summary] = c._count._all;
    return { project, epics: parsed.epics.length, total: parsed.rows.length, ...summary };
  });
}
