import { NextResponse } from "next/server";
import { requireProject } from "@/lib/auth";
import { handleWrite, body } from "@/lib/http";
import * as board from "@/lib/board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = requireProject(request);
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json(await board.listEpics(auth.project));
  } catch (error) {
    const message = error instanceof Error ? error.message : "epics read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const b = await body(request);
  return handleWrite(request, "epic-add", async ({ project, actor }) =>
    board.addEpic(project, String(b.key ?? ""), String(b.label ?? ""), b.goal ? String(b.goal) : "", actor)
  );
}
