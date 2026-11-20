// test-wiring-waived: services/board/package.json runs `tsx --test src/lib/*.test.ts`
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/db";
import * as board from "@/lib/board";
import { parseBacklog } from "@/lib/import";
import { importBoard } from "@/lib/importer";

const PROJECT = "TESTPROJ";

async function reset() {
  await prisma.auditEvent.deleteMany({ where: { project: { startsWith: PROJECT } } });
  await prisma.itemDependency.deleteMany({});
  await prisma.ownedFile.deleteMany({});
  await prisma.backlogItem.deleteMany({ where: { project: { startsWith: PROJECT } } });
  await prisma.epic.deleteMany({ where: { project: { startsWith: PROJECT } } });
  await prisma.project.deleteMany({ where: { key: { startsWith: PROJECT } } });
  await board.ensureProject(PROJECT, "Test Project");
}

before(async () => {
  await reset();
});

beforeEach(async () => {
  await reset();
});

after(async () => {
  await prisma.$disconnect();
});

test("add/queue/take/archive lifecycle and board shape", async () => {
  await board.addEpic(PROJECT, "tooling", "Tooling", "dev tooling");
  const added = await board.add(PROJECT, { task: "Do a thing", priority: "P2", epic: "tooling" });
  assert.match(added.id, /^F-\d+$/);

  let b = await board.board(PROJECT);
  assert.equal(b.open.length, 1);
  assert.equal(b.open[0].id, added.id);
  assert.equal(b.open[0].priority, "P2");

  await board.queue(PROJECT, added.id);
  b = await board.board(PROJECT);
  assert.equal(b.open.length, 0);
  assert.equal(b.queued.length, 1);

  await board.take(PROJECT, added.id, `.agents/handoffs/${added.id}.md`);
  b = await board.board(PROJECT);
  assert.equal(b.queued.length, 0);
  assert.equal(b.inprogress.length, 1);
  assert.equal(b.inprogress[0].handoff, `.agents/handoffs/${added.id}.md`);

  await board.archive(PROJECT, added.id, "shipped test");
  b = await board.board(PROJECT);
  assert.equal(b.inprogress.length, 0);
  assert.equal(b.archive.length, 1);
  assert.equal(b.archive[0].closed, "shipped test");
});

test("open rows require a valid priority and epic", async () => {
  await assert.rejects(() => board.add(PROJECT, { task: "x", priority: "P9" }), /priority must be/);
  await assert.rejects(() => board.add(PROJECT, { task: "x", epic: "nope" }), /unknown epic/);
  await assert.rejects(() => board.add(PROJECT, { task: "" }), /missing task/);
});

test("frozen rows require why/reopen and show the condition", async () => {
  const a = await board.add(PROJECT, { task: "park me" });
  await assert.rejects(() => board.freeze(PROJECT, a.id, "", ""), /provide why/);
  await board.freeze(PROJECT, a.id, "not now", "when X lands");
  const b = await board.board(PROJECT);
  assert.equal(b.frozen.length, 1);
  assert.match(b.frozen[0].condition, /not now — reopen when when X lands/);
});

test("only open rows can be queued", async () => {
  const a = await board.add(PROJECT, { task: "x" });
  await board.queue(PROJECT, a.id);
  // A repeat queue is an idempotent no-op (matches the legacy CLI).
  const again = await board.queue(PROJECT, a.id);
  assert.equal("note" in again && again.note, "already queued");
  await board.take(PROJECT, a.id);
  await assert.rejects(() => board.queue(PROJECT, a.id), /only Open/);
});

test("dependency cycles are rejected and blockers gate take", async () => {
  const a = await board.add(PROJECT, { task: "a" });
  const b = await board.add(PROJECT, { task: "b", dependsOn: a.id });
  await assert.rejects(() => board.setDepends(PROJECT, a.id, b.id), /cycle/);

  // b depends on a (open), so b is blocked and cannot be taken.
  await board.queue(PROJECT, b.id);
  await assert.rejects(() => board.take(PROJECT, b.id), /blocked — depends on/);
  await board.archive(PROJECT, a.id, "done");
  await board.take(PROJECT, b.id);
  const snapshot = await board.board(PROJECT);
  assert.equal(snapshot.inprogress[0].id, b.id);
});

test("next picks the top unblocked queued row and nextTake claims it atomically", async () => {
  const low = await board.add(PROJECT, { task: "low", priority: "P3" });
  const high = await board.add(PROJECT, { task: "high", priority: "P2" });
  await board.queue(PROJECT, low.id);
  await board.queue(PROJECT, high.id);

  const peek = await board.next(PROJECT);
  assert.equal("id" in peek && peek.id, high.id);

  const taken = await board.nextTake(PROJECT, `.agents/handoffs/${high.id}.md`);
  assert.equal("id" in taken && taken.id, high.id);
  const snapshot = await board.board(PROJECT);
  assert.equal(snapshot.queued.length, 1);
  assert.equal(snapshot.queued[0].id, low.id);
  assert.equal(snapshot.inprogress[0].id, high.id);
});

test("records an audit event for each write", async () => {
  const a = await board.add(PROJECT, { task: "audited" });
  await board.queue(PROJECT, a.id);
  const events = await board.listAudit(PROJECT, 50);
  const actions = events.map((e) => e.action);
  assert.ok(actions.includes("add"), `expected an add event in ${actions.join(",")}`);
  assert.ok(actions.includes("queue"), `expected a queue event in ${actions.join(",")}`);
});

test("concurrent adds allocate distinct ids under load", async () => {
  const N = 30;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => board.add(PROJECT, { task: `parallel ${i}` })));
  const ids = results.map((r) => r.id);
  assert.equal(new Set(ids).size, N, `expected ${N} unique ids, got ${new Set(ids).size}`);
  const rows = await prisma.backlogItem.findMany({ where: { project: PROJECT } });
  assert.equal(rows.length, N);
});

// --- parser parity ------------------------------------------------------

const FIXTURE = `# BACKLOG — canonical task list

## Epics

| Key | Label | Goal |
|---|---|---|
| tooling | Tooling | dev tooling |

## Active / next

- Next picks: _(none — no in-progress row)_

## In progress

| ID | Epic | Task | Handoff |
|---|---|---|---|
| F-003 | tooling | working | .agents/handoffs/F-003.md |

## Queued

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-002 | P2 | tooling | queued one | ? | F-003 |

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-001 | P1 | tooling | open one | file.js | ? |

## Frozen

| ID | Epic | Task | Why frozen / reopen when |
|---|---|---|---|
| F-004 | tooling | parked | not now - reopen when X lands |

## Archive (shipped · done)

| ID | Epic | Task | Closed |
|---|---|---|---|
| F-000 | tooling | shipped | shipped 2026-01-01 |
`;

test("parseBacklog reads every section including archive and splits frozen conditions", () => {
  const p = parseBacklog("PROJ", FIXTURE);
  const byStatus = (s: string) => p.rows.filter((r) => r.status === s);
  assert.equal(byStatus("open").length, 1);
  assert.equal(byStatus("queued").length, 1);
  assert.equal(byStatus("inprogress").length, 1);
  assert.equal(byStatus("frozen").length, 1);
  assert.equal(byStatus("archive").length, 1);
  assert.equal(p.epics.length, 1);
  assert.deepEqual(p.active, []);
  const dep = byStatus("queued")[0];
  assert.equal(dep.dependsOn, "F-003");
  const frozen = byStatus("frozen")[0];
  assert.equal(frozen.why, "not now");
  assert.equal(frozen.reopen, "X lands");
});

test("importBoard is idempotent and preserves row counts", async () => {
  const parsed = parseBacklog(PROJECT, FIXTURE);
  const first = await importBoard(parsed, { projectName: PROJECT });
  assert.equal(first.open, 1);
  assert.equal(first.queued, 1);
  assert.equal(first.archive, 1);
  const second = await importBoard(parsed, { projectName: PROJECT });
  assert.equal(second.total, first.total);
  const rows = await prisma.backlogItem.findMany({ where: { project: PROJECT } });
  assert.equal(rows.length, 5);
});
