import { NextResponse } from "next/server";
import { handleWrite, body } from "@/lib/http";
import * as board from "@/lib/board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleWrite(request, "add", async ({ project, actor }) => {
    const b = await body(request);
    return board.add(
      project,
      {
        task: String(b.task ?? ""),
        priority: b.priority ? String(b.priority) : undefined,
        evidence: b.evidence ? String(b.evidence) : undefined,
        epic: b.epic ? String(b.epic) : undefined,
        dependsOn: b.dependsOn ? String(b.dependsOn) : undefined,
        id: b.id ? String(b.id) : undefined,
      },
      actor
    );
  });
}
