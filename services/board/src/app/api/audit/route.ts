import { NextResponse } from "next/server";
import { requireProject } from "@/lib/auth";
import { listAudit } from "@/lib/board";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = requireProject(request);
  if (auth instanceof NextResponse) return auth;
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
  try {
    return NextResponse.json(await listAudit(auth.project, Number.isFinite(limit) ? limit : 100));
  } catch (error) {
    const message = error instanceof Error ? error.message : "audit read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
