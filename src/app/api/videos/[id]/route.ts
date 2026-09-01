import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { resolvedOutputPath } from "@/lib/config";

export const runtime = "nodejs";

function decodeId(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(base64, "base64").toString("utf8");
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const filePath = resolvedOutputPath(decodeId(id));
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || !filePath.toLowerCase().endsWith(".mp4")) return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers: {
      "content-type": "video/mp4", "content-length": String(stat.size), "cache-control": "private, max-age=3600",
    } });
  } catch { return new Response("Not found", { status: 404 }); }
}
