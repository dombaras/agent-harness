import type { Prisma } from "@/generated/client/client";
import { prisma } from "@/lib/db";
import { BoardError, ConflictError, NotFoundError } from "@/lib/errors";
import type { AddInput, BacklogBoard, Status } from "@/lib/types";

const PRIORITIES: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const STATUSES: Status[] = ["open", "queued", "inprogress", "frozen", "archive"];

function priorityRank(p: string): number {
  return Object.prototype.hasOwnProperty.call(PRIORITIES, p) ? PRIORITIES[p] : 4;
}

/** All items for a project (any status), with deps + owned files. */
function itemInclude() {
  return { deps: true, owned: true } as const;
}

export async function allItems(project: string) {
  return prisma.backlogItem.findMany({
    where: { project },
    include: itemInclude(),
    orderBy: [{ sortOrder: "asc" }, { itemId: "asc" }],
  });
}

/** The frozen `BacklogBoard` shape (ADR 0001 §5). */
export async function board(project: string): Promise<BacklogBoard> {
  const [projectRow, items] = await Promise.all([
    prisma.project.findUnique({ where: { key: project } }),
    allItems(project),
  ]);
  if (!projectRow) throw new NotFoundError(`unknown project ${project}`);

  const epics = await prisma.epic.findMany({ where: { project }, orderBy: { key: "asc" } });
  const byStatus = (s: Status) => items.filter((i) => i.status === s).sort((a, b) => a.sortOrder - b.sortOrder);
  const uuidToItem = new Map(items.map((i) => [i.id, i.itemId]));
  const depsOf = (i: { deps: { dependsOn: string }[] }) =>
    i.deps.map((d) => uuidToItem.get(d.dependsOn) ?? d.dependsOn).join(", ");

  return {
    epics: epics.map((e) => ({ key: e.key, label: e.label, goal: e.goal })),
    active: projectRow.active ?? [],
    inprogress: byStatus("inprogress").map((i) => ({ id: i.itemId, epic: i.epic, task: i.task, handoff: i.handoff })),
    queued: byStatus("queued")
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
      .map((i) => ({ id: i.itemId, priority: i.priority, epic: i.epic, task: i.task, evidence: i.evidence, dependsOn: depsOf(i) })),
    open: byStatus("open")
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
      .map((i) => ({ id: i.itemId, priority: i.priority, epic: i.epic, task: i.task, evidence: i.evidence, dependsOn: depsOf(i) })),
    frozen: byStatus("frozen").map((i) => ({
      id: i.itemId,
      epic: i.epic,
      task: i.task,
      condition: [i.why, i.reopen ? `reopen when ${i.reopen}` : ""].filter(Boolean).join(" — "),
    })),
    archive: byStatus("archive").map((i) => ({ id: i.itemId, epic: i.epic, task: i.task, closed: i.closed })),
  };
}

/* ------------------------------------------------------------ helpers */

async function audit(
  tx: Prisma.TransactionClient,
  project: string,
  action: string,
  itemId: string,
  actor: string,
  payload?: Prisma.InputJsonValue
) {
  await tx.auditEvent.create({ data: { project, action, itemId, actor, payload } });
}

async function epicKeys(project: string, tx: Prisma.TransactionClient = prisma): Promise<Set<string>> {
  const rows = await tx.epic.findMany({ where: { project }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

function validEpic(epic: string, keys: Set<string>): boolean {
  return epic === "?" || keys.has(epic);
}

function parseDeps(raw: string | undefined): string[] {
  const on = (raw ?? "").trim();
  if (on === "" || on === "?") return [];
  return on.split(/[\s,]+/).filter(Boolean);
}

async function knownIds(project: string): Promise<Set<string>> {
  const rows = await prisma.backlogItem.findMany({ where: { project }, select: { itemId: true } });
  return new Set(rows.map((r) => r.itemId));
}

/** Allocate the next free F-number inside the caller's transaction. */
async function nextItemIdTx(tx: Prisma.TransactionClient, project: string): Promise<string> {
  const rows = await tx.backlogItem.findMany({ where: { project }, select: { itemId: true } });
  let max = 0;
  for (const r of rows) {
    const m = /^(?:F|T)-(\d+)$/i.exec(r.itemId);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "F-" + String(max + 1).padStart(3, "0");
}

/**
 * Serialize ID allocation per project with a Postgres advisory lock, so two
 * concurrent `add`s can never both read the same max and collide (the F-195
 * duplicate-ID bug). The lock is transaction-scoped — released at commit.
 */
async function lockProject(tx: Prisma.TransactionClient, project: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${project}))`;
}

/** Reject a dependency graph that would introduce a cycle. */
async function assertNoCycle(project: string, id: string, deps: string[], tx: Prisma.TransactionClient = prisma) {
  if (!deps.length) return;
  const rows = await tx.backlogItem.findMany({
    where: { project },
    include: { deps: true },
  });
  const uuidToItem = new Map(rows.map((r) => [r.id, r.itemId]));
  const graph = new Map<string, string[]>();
  for (const r of rows) graph.set(r.itemId, r.deps.map((d) => uuidToItem.get(d.dependsOn) ?? d.dependsOn));
  graph.set(id, deps); // the prospective row wins for this check
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (done.has(node)) return false;
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) if (walk(dep)) return true;
    visiting.delete(node);
    done.add(node);
    return false;
  };
  for (const node of graph.keys()) {
    if (walk(node)) throw new BoardError(`dependencies for ${id} would create a cycle`);
  }
}

async function getItemOrThrow(project: string, itemId: string, tx: Prisma.TransactionClient = prisma) {
  const item = await tx.backlogItem.findUnique({
    where: { project_itemId: { project, itemId } },
    include: itemInclude(),
  });
  if (!item) throw new NotFoundError(`no row ${itemId} in the board`);
  return item;
}

/** Max+1 sortOrder within a bucket, so order is stable and import-friendly. */
async function nextSortOrder(tx: Prisma.TransactionClient, project: string, status: Status): Promise<number> {
  const agg = await tx.backlogItem.aggregate({ where: { project, status }, _max: { sortOrder: true } });
  return (agg._max.sortOrder ?? -1) + 1;
}

const STATUSES_SET = new Set<string>(STATUSES);
function asStatus(value: string): Status {
  if (!STATUSES_SET.has(value)) throw new BoardError(`unknown status ${value}`);
  return value as Status;
}

/* ------------------------------------------------------------ commands */

export async function add(project: string, input: AddInput, actor = "") {
  const task = (input.task ?? "").trim();
  if (!task) throw new BoardError("add: missing task");
  const priority = (input.priority ?? "P3").toUpperCase();
  if (!(priority in PRIORITIES)) throw new BoardError(`add: priority must be P1..P4 (got "${priority}")`);
  const evidence = input.evidence ?? "?";
  const epic = input.epic ?? "?";

  return prisma.$transaction(async (tx) => {
    // Serialize allocation + validation per project so concurrent adds cannot
    // collide on an ID or race the dependency graph.
    await lockProject(tx, project);
    const keys = new Set((await tx.epic.findMany({ where: { project }, select: { key: true } })).map((e) => e.key));
    if (!validEpic(epic, keys)) throw new BoardError(`add: unknown epic "${epic}" (use ? or add the epic first)`);
    const known = new Set((await tx.backlogItem.findMany({ where: { project }, select: { itemId: true } })).map((r) => r.itemId));
    const deps = parseDeps(input.dependsOn);
    for (const d of deps) if (!known.has(d)) throw new BoardError(`add: depends on unknown row ${d}`);

    const id = input.id?.trim() || (await nextItemIdTx(tx, project));
    if (known.has(id)) throw new BoardError(`add: duplicate ID ${id}`);
    await assertNoCycle(project, id, deps, tx);

    const item = await tx.backlogItem.create({
      data: {
        project,
        itemId: id,
        status: "open",
        priority,
        epic,
        task,
        evidence,
        sortOrder: await nextSortOrder(tx, project, "open"),
      },
    });
    for (const d of deps) {
      const dep = await tx.backlogItem.findUnique({ where: { project_itemId: { project, itemId: d } } });
      if (dep) await tx.itemDependency.create({ data: { itemId: item.id, dependsOn: dep.id } });
    }
    await audit(tx, project, "add", id, actor, { priority, epic, evidence });
    return { id, priority, epic, task, evidence };
  });
}

async function move(tx: Prisma.TransactionClient, project: string, itemId: string, to: Status, data: Prisma.BacklogItemUpdateInput, action: string, actor: string) {
  const item = await tx.backlogItem.findUnique({ where: { project_itemId: { project, itemId } } });
  if (!item) throw new NotFoundError(`no row ${itemId} in the board`);
  const updated = await tx.backlogItem.update({
    where: { id: item.id },
    data: { ...data, status: to, sortOrder: await nextSortOrder(tx, project, to) },
  });
  await audit(tx, project, action, itemId, actor, undefined);
  return updated;
}

export async function queue(project: string, itemId: string, actor = "") {
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status === "queued") return { id: itemId, note: "already queued" };
    if (item.status !== "open") throw new ConflictError(`queue: ${itemId} is ${item.status} — only Open rows can be queued`);
    await move(tx, project, itemId, "queued", {}, "queue", actor);
    return { id: itemId, queued: true };
  });
}

export async function unqueue(project: string, itemId: string, actor = "") {
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status === "open") return { id: itemId, note: "already Open" };
    if (item.status !== "queued") throw new ConflictError(`unqueue: ${itemId} is ${item.status} — only Queued rows can be returned to Open`);
    await move(tx, project, itemId, "open", {}, "unqueue", actor);
    return { id: itemId, unqueued: true };
  });
}

export async function take(project: string, itemId: string, handoff?: string, actor = "") {
  if (handoff && handoff !== "?" && !/^\.agents[\\/]handoffs[\\/].+\.md$/.test(handoff)) {
    throw new BoardError(`handoff must be a real path under .agents/handoffs/ ending in .md (e.g. .agents/handoffs/${itemId}.md)`);
  }
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status === "inprogress") return { id: itemId, note: "already In progress" };
    if (item.status === "frozen") throw new ConflictError(`take: ${itemId} is Frozen — unfreeze it first`);
    if (item.status === "archive") throw new ConflictError(`take: ${itemId} is archived`);

    const deps = await tx.itemDependency.findMany({ where: { itemId: item.id }, include: { dependency: true } });
    const blockers = deps.filter((d) => d.dependency.status !== "archive").map((d) => d.dependency.itemId);
    if (blockers.length) throw new ConflictError(`take: ${itemId} is blocked — depends on ${blockers.join(", ")} (not yet archived)`);

    await move(tx, project, itemId, "inprogress", { handoff: handoff ?? "?" }, "take", actor);
    return { id: itemId, taken: true };
  });
}

export async function archive(project: string, itemId: string, closed?: string, actor = "") {
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status === "archive") {
      if (!closed) return { id: itemId, note: "already archived" };
      const updated = await tx.backlogItem.update({ where: { id: item.id }, data: { closed } });
      await audit(tx, project, "archive", itemId, actor, { repaired: true });
      return { id: itemId, note: "already archived", closed: updated.closed };
    }
    await move(tx, project, itemId, "archive", { closed: closed ?? "shipped" }, "archive", actor);
    return { id: itemId, archived: true };
  });
}

export async function freeze(project: string, itemId: string, why: string, reopen: string, actor = "") {
  if (!why && !reopen) throw new BoardError("freeze: provide why and/or reopen");
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status === "frozen") return { id: itemId, note: "already frozen" };
    await move(tx, project, itemId, "frozen", { why, reopen }, "freeze", actor);
    return { id: itemId, frozen: true };
  });
}

export async function reopen(project: string, itemId: string, reason: string, priority: string, actor = "") {
  const p = (priority || "P2").toUpperCase();
  if (!(p in PRIORITIES)) throw new BoardError(`reopen: priority must be P1..P4 (got "${p}")`);
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status === "open") return { id: itemId, note: "already Open" };
    if (item.status === "queued" || item.status === "inprogress") {
      throw new ConflictError(`reopen: ${itemId} is ${item.status} — only Archive/Frozen rows are reopened`);
    }
    await move(tx, project, itemId, "open", { priority: p, evidence: reason || "reopened" }, "reopen", actor);
    return { id: itemId, reopened: true };
  });
}

export async function setPriority(project: string, itemId: string, priority: string, actor = "") {
  const p = (priority || "").toUpperCase();
  if (!(p in PRIORITIES)) throw new BoardError(`priority: priority must be P1..P4 (got "${priority || "none"}")`);
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status !== "open" && item.status !== "queued") {
      throw new ConflictError(`priority: ${itemId} is ${item.status} — only Open/Queued rows have a priority`);
    }
    await tx.backlogItem.update({ where: { id: item.id }, data: { priority: p } });
    await audit(tx, project, "priority", itemId, actor, { priority: p });
    return { id: itemId, priority: p };
  });
}

export async function setEpic(project: string, itemId: string, to: string, actor = "") {
  const keys = await epicKeys(project);
  if (!validEpic(to, keys)) throw new BoardError(`epic: unknown epic "${to}"`);
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    await tx.backlogItem.update({ where: { id: item.id }, data: { epic: to } });
    await audit(tx, project, "epic", itemId, actor, { epic: to });
    return { id: itemId, epic: to };
  });
}

export async function setDepends(project: string, itemId: string, on: string, actor = "") {
  const deps = parseDeps(on);
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    if (item.status !== "open" && item.status !== "queued") {
      throw new ConflictError(`depends: ${itemId} is ${item.status} — only Open/Queued rows carry dependencies`);
    }
    const known = new Set((await tx.backlogItem.findMany({ where: { project }, select: { itemId: true } })).map((r) => r.itemId));
    for (const d of deps) if (!known.has(d)) throw new BoardError(`depends: ${itemId} references unknown row ${d}`);
    await assertNoCycle(project, itemId, deps, tx);
    await tx.itemDependency.deleteMany({ where: { itemId: item.id } });
    for (const d of deps) {
      const dep = await tx.backlogItem.findUnique({ where: { project_itemId: { project, itemId: d } } });
      if (dep) await tx.itemDependency.create({ data: { itemId: item.id, dependsOn: dep.id } });
    }
    await audit(tx, project, "depends", itemId, actor, { deps });
    return { id: itemId, dependsOn: deps.join(", ") };
  });
}

export async function setOwns(project: string, itemId: string, files: string, actor = "") {
  const globs = (files ?? "").trim() === "" || files.trim() === "?" ? [] : files.split(",").map((f) => f.trim()).filter(Boolean);
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    await tx.ownedFile.deleteMany({ where: { itemId: item.id } });
    for (const glob of globs) await tx.ownedFile.create({ data: { itemId: item.id, glob } });
    await audit(tx, project, "owns", itemId, actor, { globs });
    return { id: itemId, files: globs.join(", ") };
  });
}

export async function recordWorktree(project: string, itemId: string, dir: string, branch: string, handoff?: string, actor = "") {
  return prisma.$transaction(async (tx) => {
    const item = await getItemOrThrow(project, itemId, tx);
    await move(tx, project, itemId, "inprogress", { worktree: dir, handoff: handoff ?? item.handoff, }, "worktree", actor);
    await audit(tx, project, "worktree", itemId, actor, { dir, branch });
    return { id: itemId, worktree: dir, branch };
  });
}

export async function addEpic(project: string, key: string, label: string, goal: string, actor = "") {
  if (!key) throw new BoardError("epic-add: missing key");
  if (!label) throw new BoardError("epic-add: missing label");
  return prisma.$transaction(async (tx) => {
    const exists = await tx.epic.findUnique({ where: { project_key: { project, key } } });
    if (exists) throw new BoardError(`epic-add: duplicate epic "${key}"`);
    await tx.epic.create({ data: { project, key, label, goal } });
    await audit(tx, project, "epic-add", "", actor, { key, label });
    return { key, label, goal };
  });
}

/** Top unblocked queued row (by priority), or null. */
export async function next(project: string) {
  const items = await allItems(project);
  const queued = items.filter((i) => i.status === "queued").sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  if (!queued.length) return { empty: true as const };
  const byUuid = new Map(items.map((i) => [i.id, i]));
  const blocked: string[] = [];
  for (const row of queued) {
    const blockers = row.deps.map((d) => byUuid.get(d.dependsOn)).filter((d) => d && d.status !== "archive");
    if (blockers.length) {
      blocked.push(row.itemId);
      continue;
    }
    return { id: row.itemId, priority: row.priority, epic: row.epic, task: row.task, evidence: row.evidence };
  }
  return { empty: true as const, blocked };
}

/** Atomically claim the top unblocked queued row -> inprogress. */
export async function nextTake(project: string, handoff?: string, actor = "") {
  return prisma.$transaction(async (tx) => {
    const items = await tx.backlogItem.findMany({ where: { project, status: "queued" }, include: { deps: true } });
      const all = await tx.backlogItem.findMany({ where: { project }, select: { id: true, itemId: true, status: true } });
    const byId = new Map(all.map((i) => [i.id, i]));
    const sorted = items.slice().sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    for (const row of sorted) {
      const blockers = row.deps.map((d) => byId.get(d.dependsOn)).filter((d) => d && d.status !== "archive");
      if (blockers.length) continue;
      await tx.backlogItem.update({
        where: { id: row.id },
        data: { status: "inprogress", handoff: handoff ?? "?", sortOrder: await nextSortOrder(tx, project, "inprogress") },
      });
      await audit(tx, project, "next-take", row.itemId, actor, undefined);
      return { id: row.itemId, priority: row.priority, epic: row.epic, task: row.task, handoff: handoff ?? "?" };
    }
    return { empty: true as const };
  });
}

export async function listEpics(project: string) {
  return prisma.epic.findMany({ where: { project }, orderBy: { key: "asc" } });
}

export async function listAudit(project: string, limit = 100) {
  return prisma.auditEvent.findMany({ where: { project }, orderBy: { ts: "desc" }, take: Math.min(Math.max(limit, 1), 1000) });
}

export async function ensureProject(project: string, name = "") {
  return prisma.project.upsert({ where: { key: project }, update: {}, create: { key: project, name } });
}

export { asStatus, priorityRank };
