import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, service: "agent-board" });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "db unavailable" }, { status: 503 });
  }
}
