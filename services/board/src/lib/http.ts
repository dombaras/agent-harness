import { NextResponse } from "next/server";
import { requireProject } from "@/lib/auth";
import { board, ensureProject } from "@/lib/board";
import { publish } from "@/lib/bus";
import { errorResponse } from "@/lib/errors";

export interface Ctx {
  project: string;
  actor: string;
}

/** Parse a JSON body (empty body -> {}). */
async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function actor(request: Request): string {
  return (request.headers.get("x-actor") ?? "").trim();
}

/**
 * The shared handler for every board write: authenticate, run the mutation,
 * emit one `backlog_changed` SSE event, and return the refreshed board — the
 * exact response the superadmin route consumes today (ADR 0001 §5).
 */
export async function handleWrite(
  request: Request,
  action: string,
  run: (ctx: Ctx) => Promise<unknown>
): Promise<NextResponse> {
  const auth = requireProject(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const ctx: Ctx = { project: auth.project, actor: actor(request) };
    // A token is pre-authorized for its project; provision it on first write so
    // a fresh tenant does not need an out-of-band setup step.
    await ensureProject(ctx.project, ctx.project);
    const result = await run(ctx);
    publish(auth.project, action, "", ctx.actor);
    const snapshot = await board(auth.project);
    return NextResponse.json({ ok: true, result, board: snapshot });
  } catch (error) {
    const { status, body: errBody } = errorResponse(error);
    return NextResponse.json(errBody, { status });
  }
}

export { body };
