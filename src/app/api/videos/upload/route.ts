import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig, toRelativeOutputPath } from "@/lib/config";

export const runtime = "nodejs";
const MAX_UPLOAD_BYTES = 800 * 1024 * 1024;

function safeName(name: string) { return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "") || "video.mp4"; }

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("video");
    if (!(file instanceof File)) return Response.json({ error: "Chọn file MP4." }, { status: 400 });
    if (!file.name.toLowerCase().endsWith(".mp4") || !file.type.startsWith("video/")) return Response.json({ error: "Chỉ nhận file MP4." }, { status: 400 });
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "MP4 phải lớn hơn 0 và không quá 800 MB." }, { status: 400 });
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const dir = path.join(appConfig.outputDir(), date, "manual");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${Date.now()}-${safeName(file.name)}`);
    await fs.writeFile(target, Buffer.from(await file.arrayBuffer()), { mode: 0o640 });
    return Response.json({ ok: true, path: toRelativeOutputPath(target) }, { status: 201 });
  } catch (error) { return Response.json({ error: error instanceof Error && error.message ? error.message : "Không tải được MP4." }, { status: 500 }); }
}
