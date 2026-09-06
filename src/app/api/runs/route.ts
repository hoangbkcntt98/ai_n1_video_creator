import { startGeneration } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; patternId?: unknown; patternName?: unknown; forceRecreate?: unknown };
    const forceRecreate = body.forceRecreate === true;
    if (body.action === "create_next") {
      const run = await startGeneration({});
      return Response.json({ run }, { status: 202 });
    }
    if (body.action === "generate_pattern") {
      const run = await startGeneration({ patternId: Number(body.patternId), patternName: typeof body.patternName === "string" ? body.patternName : "", forceRecreate });
      return Response.json({ run }, { status: 202 });
    }
    return Response.json({ error: "Action không hợp lệ." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Không khởi động được pipeline.";
    const status = /unique|duplicate|active_run/i.test(message) ? 409 : 500;
    return Response.json({ error: status === 409 ? "Đang có pipeline hoặc Facebook upload chạy. Chờ run hiện tại xong." : message }, { status });
  }
}
