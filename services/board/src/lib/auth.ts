import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Token -> project map, parsed from `BOARD_TOKENS` ("tok:Project,tok2:Project2").
 * A project's token is its only credential; the board service trusts the token
 * to name the tenant, exactly like the ADR's frozen contract (ADR 0001 §6).
 */
export function tokenMap(): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (process.env.BOARD_TOKENS ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const token = trimmed.slice(0, idx).trim();
    const project = trimmed.slice(idx + 1).trim();
    if (token && project) out.set(token, project);
  }
  return out;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolves the project for a request. Returns a `NextResponse` (401/403) when
 * the token is missing or unknown, otherwise the `{ project }` identity.
 * A cross-project `X-Project` header that disagrees with the token is rejected.
 */
export function requireProject(request: Request): { project: string } | NextResponse {
  const token = bearerToken(request);
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = tokenMap().get(token);
  if (!project) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const claimed = request.headers.get("x-project");
  if (claimed && claimed !== project) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { project };
}

export function requireProjectOrThrow(request: NextRequest | Request): string {
  const auth = requireProject(request);
  if (auth instanceof NextResponse) throw auth;
  return auth.project;
}
