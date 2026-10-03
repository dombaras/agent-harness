import { NextResponse } from "next/server";
import { requireProject } from "@/lib/auth";
import { next, ensureProject } from "@/lib/board";
import { errorResponse } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = requireProject(request);
  if (auth instanceof NextResponse) return auth;
  try {
    await ensureProject(auth.project, auth.project);
    return NextResponse.json(await next(auth.project));
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
