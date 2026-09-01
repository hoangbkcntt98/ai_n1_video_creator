import { startFacebookPublish } from "@/lib/pipeline";
import { saveVideoDetails } from "@/lib/video";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { path?: unknown; title?: unknown; caption?: unknown };
    if (typeof body.path !== "string") return Response.json({ error: "Thiếu đường dẫn video." }, { status: 400 });
    await saveVideoDetails(body.path, { title: typeof body.title === "string" ? body.title : "", caption: typeof body.caption === "string" ? body.caption : "" });
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: error instanceof Error && error.message ? error.message : "Không lưu được video." }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; path?: unknown; caption?: unknown; confirmPublish?: unknown };
    if (body.action !== "publish" || body.confirmPublish !== true) return Response.json({ error: "Cần xác nhận đăng Facebook." }, { status: 400 });
    if (typeof body.path !== "string" || typeof body.caption !== "string") return Response.json({ error: "Thiếu video hoặc caption." }, { status: 400 });
    await saveVideoDetails(body.path, { caption: body.caption });
    const run = await startFacebookPublish(body.path, body.caption);
    return Response.json({ run }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Không khởi động được Facebook upload.";
    return Response.json({ error: /unique|duplicate|active_run/i.test(message) ? "Đang có pipeline hoặc Facebook upload chạy." : message }, { status: 500 });
  }
}
