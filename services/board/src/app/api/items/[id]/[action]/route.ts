import { NextResponse } from "next/server";
import { handleWrite, body } from "@/lib/http";
import * as board from "@/lib/board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One dispatcher for every row transition (ADR 0001 §5):
 * take · queue · unqueue · archive · freeze · reopen · priority · epic ·
 * depends · owns · worktree.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  const b = await body(request);
  const str = (key: string) => (b[key] === undefined || b[key] === null ? undefined : String(b[key]));

  return handleWrite(request, action, async ({ project, actor }) => {
    switch (action) {
      case "take":
        return board.take(project, id, str("handoff"), actor);
      case "queue":
        return board.queue(project, id, actor);
      case "unqueue":
        return board.unqueue(project, id, actor);
      case "archive":
        return board.archive(project, id, str("closed"), actor);
      case "freeze":
        return board.freeze(project, id, str("why") ?? "", str("reopen") ?? "", actor);
      case "reopen":
        return board.reopen(project, id, str("reason") ?? "", str("priority") ?? "P2", actor);
      case "priority":
        return board.setPriority(project, id, str("priority") ?? "", actor);
      case "epic":
        return board.setEpic(project, id, str("to") ?? "", actor);
      case "depends":
        return board.setDepends(project, id, str("on") ?? "?", actor);
      case "owns":
        return board.setOwns(project, id, str("files") ?? "?", actor);
      case "worktree":
        return board.recordWorktree(project, id, str("dir") ?? "", str("branch") ?? id.toLowerCase(), str("handoff"), actor);
      default:
        return NextResponse.json({ error: `unknown action "${action}"` }, { status: 404 });
    }
  });
}
