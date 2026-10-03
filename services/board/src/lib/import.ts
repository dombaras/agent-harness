import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The board parser is harness-owned; reuse it so the import sees the same rows.
const { splitCells, isSep } = require("../../../../templates/scripts/qa/board-lib.js") as {
  splitCells(row: string): string[];
  isSep(cells: string[]): boolean;
};

export interface ParsedBoard {
  project: string;
  epics: { key: string; label: string; goal: string }[];
  active: string[];
  rows: {
    status: "open" | "queued" | "inprogress" | "frozen" | "archive";
    id: string;
    priority: string;
    epic: string;
    task: string;
    evidence: string;
    handoff: string;
    why: string;
    reopen: string;
    closed: string;
    dependsOn: string;
    sortOrder: number;
  }[];
}

/** Map a `## …` heading to a section, normalizing spacing/punctuation. */
function sectionFor(heading: string): ParsedBoard["rows"][number]["status"] | "epics" | "active" | null {
  const h = heading.trim().toLowerCase();
  if (h.startsWith("## epics")) return "epics";
  if (h.startsWith("## active")) return "active";
  if (h.startsWith("## in progress")) return "inprogress";
  if (h.startsWith("## queued")) return "queued";
  if (h.startsWith("## open")) return "open";
  if (h.startsWith("## frozen")) return "frozen";
  if (h.startsWith("## archive")) return "archive";
  return null;
}

function tableRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = splitCells(t);
    // trim leading/trailing empty cells from the outer pipes
    if (cells.length && cells[0] === "") cells.shift();
    if (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (isSep(cells)) continue;
    rows.push(cells);
  }
  return rows;
}

function parseDeps(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return v === "?" ? "" : v;
}

/** Parse a legacy `BACKLOG.md` into the board model (pure; no DB). */
export function parseBacklog(project: string, source: string): ParsedBoard {
  const lines = source.split(/\r?\n/);
  const out: ParsedBoard = { project, epics: [], active: [], rows: [] };

  let section: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (!section) return;
    const rows = tableRows(buffer);
    if (section === "epics") {
      for (const r of rows) {
        if (r.length >= 2 && r[0] && r[0].toLowerCase() !== "key") {
          out.epics.push({ key: r[0], label: r[1], goal: r[2] ?? "" });
        }
      }
    } else if (section === "active") {
      for (const line of buffer) {
        const t = line.trim();
        // Ignore the italic placeholder the template ships, which itself starts
        // with "Next picks:" and embeds "_(…)_" — F-321's board proves it is not
        // real active work.
        if (!/^\s*[-*]\s+/.test(t)) continue;
        if (/^\s*[-*]\s+_.*_\s*$/.test(t)) continue;
        const value = t.replace(/^\s*[-*]\s+/, "").trim();
        if (/^next picks:/i.test(value)) continue;
        out.active.push(value);
      }
    } else {
      const status = section as ParsedBoard["rows"][number]["status"];
      let order = 0;
      for (const r of rows) {
        if (!r[0] || r[0].toLowerCase() === "id") continue;
        const base = { status, id: r[0], sortOrder: order++, priority: "?", epic: "?", task: "", evidence: "", handoff: "", why: "", reopen: "", closed: "", dependsOn: "" };
        if (status === "open" || status === "queued") {
          // [id, p, epic, task, evidence, dependsOn]
          out.rows.push({ ...base, priority: r[1] ?? "?", epic: r[2] || "?", task: r[3] ?? "", evidence: r[4] ?? "", dependsOn: parseDeps(r[5]) });
        } else if (status === "inprogress") {
          // [id, epic, task, handoff]
          out.rows.push({ ...base, epic: r[1] || "?", task: r[2] ?? "", handoff: r[3] ?? "" });
        } else if (status === "archive") {
          // [id, epic, task, closed]
          out.rows.push({ ...base, epic: r[1] || "?", task: r[2] ?? "", closed: r[3] ?? "" });
        } else {
          // frozen: [id, epic, task, condition] -> split condition into why/reopen
          // The CLI joins them as "<why> — reopen when <reopen>"; the em-dash is
          // normalized here so an ASCII "-" written by hand also round-trips.
          const cond = r[3] ?? "";
          const m = /^(.*?)\s*[—–-]\s*reopen when\s+(.*)$/.exec(cond);
          out.rows.push({ ...base, epic: r[1] || "?", task: r[2] ?? "", why: m ? m[1] : cond, reopen: m ? m[2] : "" });
        }
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("## ")) {
      flush();
      section = sectionFor(line);
      continue;
    }
    if (section) buffer.push(line);
  }
  flush();
  return out;
}

export function parseBacklogFile(root: string): ParsedBoard {
  const file = path.join(root, "BACKLOG.md");
  if (!fs.existsSync(file)) throw new Error(`no BACKLOG.md at ${file}`);
  return parseBacklog(path.basename(root), fs.readFileSync(file, "utf8"));
}
