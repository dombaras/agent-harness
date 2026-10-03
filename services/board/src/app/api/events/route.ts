import { NextResponse } from "next/server";
import { requireProject } from "@/lib/auth";
import { subscribe } from "@/lib/bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** SSE stream of board changes, matching the legacy backlog stream contract. */
export async function GET(request: Request) {
  const auth = requireProject(request);
  if (auth instanceof NextResponse) return auth;
  const project = auth.project;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (eventType: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("initial", { timestamp: new Date().toISOString() });

      const unsubscribe = subscribe((event) => {
        if (event.project === project) send("backlog_changed", event);
      });
      const ping = setInterval(() => send("ping", { time: new Date().toISOString() }), 15000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
