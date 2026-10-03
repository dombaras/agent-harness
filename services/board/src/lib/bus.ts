/**
 * In-process SSE fan-out for `backlog_changed` events (single instance, ADR §9).
 * A later multi-instance deployment swaps this for Postgres LISTEN/NOTIFY.
 */
export interface BoardEvent {
  type: "backlog_changed";
  project: string;
  actor: string;
  action: string;
  itemId: string;
  ts: string;
}

type Listener = (event: BoardEvent) => void;

const globalForBus = globalThis as unknown as { boardListeners?: Set<Listener> };
const listeners = (globalForBus.boardListeners ??= new Set<Listener>());

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(project: string, action: string, itemId: string, actor: string): void {
  const event: BoardEvent = { type: "backlog_changed", project, actor, action, itemId, ts: new Date().toISOString() };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a broken stream must not break the write */
    }
  }
}
