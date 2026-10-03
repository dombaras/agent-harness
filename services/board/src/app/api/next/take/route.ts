import { handleWrite, body } from "@/lib/http";
import * as board from "@/lib/board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const b = await body(request);
  return handleWrite(request, "next-take", async ({ project, actor }) =>
    board.nextTake(project, b.handoff ? String(b.handoff) : undefined, actor)
  );
}
