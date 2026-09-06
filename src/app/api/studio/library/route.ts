import { deleteVideo } from "@/lib/video";
import { deleteLibraryAsset, getStudioLibrary } from "@/lib/studioLibrary";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await getStudioLibrary());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Không đọc được library." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as { category?: unknown; path?: unknown };
    const category = body.category;
    const relativePath = body.path;
    if ((category !== "images" && category !== "audio" && category !== "videos") || typeof relativePath !== "string" || !relativePath.trim()) {
      return Response.json({ error: "Loại hoặc đường dẫn library không hợp lệ." }, { status: 400 });
    }

    if (category === "videos") {
      await deleteVideo(relativePath.trim());
    } else {
      await deleteLibraryAsset(relativePath.trim(), category);
    }
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không xóa được item trong library.";
    const status = /không tìm thấy/i.test(message) ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}
