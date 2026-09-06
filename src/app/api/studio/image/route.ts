import { promises as fs } from "node:fs";
import path from "node:path";
import { appConfig } from "@/lib/config";
import { ensureStudioDirs, safeStudioName, studioRoot } from "@/lib/studio";
import { saveLibraryAsset } from "@/lib/studioLibrary";

export const runtime = "nodejs";
const MAX_PROMPT = 12000;

function extensionFor(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  return ".png";
}

async function imageBytes(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("image/") || contentType.includes("octet-stream")) {
    return { bytes: Buffer.from(await response.arrayBuffer()), extension: extensionFor(contentType) };
  }
  const raw = await response.arrayBuffer();
  const rawBytes = Buffer.from(raw);
  let payload: {
    data?: Array<{ b64_json?: string; url?: string }>;
    b64_json?: string;
    url?: string;
  };
  try {
    payload = JSON.parse(rawBytes.toString("utf8")) as typeof payload;
  } catch {
    if (rawBytes.length) return { bytes: rawBytes, extension: ".png" };
    throw new Error("Gateway không trả dữ liệu ảnh hợp lệ.");
  }
  const item = payload.data?.[0] || payload;
  if (item.b64_json) return { bytes: Buffer.from(item.b64_json, "base64"), extension: ".png" };
  if (item.url) {
    const imageResponse = await fetch(item.url);
    if (!imageResponse.ok) throw new Error("Gateway không trả được ảnh.");
    const type = imageResponse.headers.get("content-type") || "image/png";
    return { bytes: Buffer.from(await imageResponse.arrayBuffer()), extension: extensionFor(type) };
  }
  throw new Error("Gateway không trả dữ liệu ảnh hợp lệ.");
}

export async function POST(request: Request) {
  let temporaryPath = "";
  try {
    const body = await request.json() as { prompt?: unknown; name?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return Response.json({ error: "Nhập prompt tạo ảnh." }, { status: 400 });
    if (prompt.length > MAX_PROMPT) return Response.json({ error: `Prompt tối đa ${MAX_PROMPT} ký tự.` }, { status: 400 });

    const image = appConfig.pipelineConfig().image;
    const endpoint = `${image.baseUrl.replace(/\/+$/, "")}/images/generations?response_format=binary`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${image.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: image.model, prompt, size: image.size }),
      signal: AbortSignal.timeout(image.timeout * 1000),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Tạo ảnh thất bại (${response.status}): ${details.slice(-1000)}`);
    }

    const { bytes, extension } = await imageBytes(response);
    if (!bytes.length) throw new Error("Ảnh tạo ra rỗng.");
    await ensureStudioDirs();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const baseName = safeStudioName(name || prompt.slice(0, 48), "generated-image");
    temporaryPath = path.join(studioRoot(), "uploads", `${Date.now()}-${baseName}${extension}`);
    await fs.writeFile(temporaryPath, bytes, { mode: 0o640 });
    const libraryPath = await saveLibraryAsset(temporaryPath, "images", `${baseName}${extension}`);
    return Response.json({
      ok: true,
      path: libraryPath,
      name: path.basename(libraryPath),
      size: bytes.length,
    }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Không tạo được ảnh." }, { status: 500 });
  } finally {
    if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}
