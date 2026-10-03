/** The board JSON shape consumed by the superadmin UI (ADR 0001 §5). */
export interface BacklogBoard {
  epics: { key: string; label: string; goal: string }[];
  active: string[];
  inprogress: { id: string; epic: string; task: string; handoff: string }[];
  queued: { id: string; priority: string; epic: string; task: string; evidence: string; dependsOn: string }[];
  open: { id: string; priority: string; epic: string; task: string; evidence: string; dependsOn: string }[];
  frozen: { id: string; epic: string; task: string; condition: string }[];
  archive: { id: string; epic: string; task: string; closed: string }[];
}

export type Status = "open" | "queued" | "inprogress" | "frozen" | "archive";

export interface AddInput {
  task: string;
  priority?: string;
  evidence?: string;
  epic?: string;
  dependsOn?: string;
  id?: string;
}
