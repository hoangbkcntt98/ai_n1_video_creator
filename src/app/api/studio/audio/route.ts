import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { resolveStudioPath } from "@/lib/studio";

export const runtime = "nodejs";
const contentTypes: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg" };

export async function GET(request: Request) {
  try {
    const relative = new URL(request.url).searchParams.get("path");
    if (!relative) return new Response("Not found", { status: 404 });
    const filePath = resolveStudioPath(relative);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers: {
      "content-type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "content-length": String(stat.size), "cache-control": "private, max-age=3600",
    } });
  } catch { return new Response("Not found", { status: 404 }); }
}
