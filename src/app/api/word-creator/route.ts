import { NextRequest, NextResponse } from "next/server";
import { listWordCreatorQuestions, listWordCreatorSources } from "@/lib/wordCreator/index";
import { enqueueWordCreator, getWordCreatorJob } from "@/lib/wordCreator/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("sources") === "1") {
      const offset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return NextResponse.json({ error: "offset không hợp lệ." }, { status: 400 });
      }
      return NextResponse.json(await listWordCreatorSources(request.nextUrl.searchParams.get("q") || "", offset),
        { headers: { "Cache-Control": "no-store" } });
    }
    const id = request.nextUrl.searchParams.get("jobId");
    if (id !== null) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return NextResponse.json({ error: "jobId không hợp lệ." }, { status: 400 });
      }
      const job = await getWordCreatorJob(id);
      return job
        ? NextResponse.json({ job }, { headers: { "Cache-Control": "no-store" } })
        : NextResponse.json({ error: "Không tìm thấy tác vụ." }, { status: 404 });
    }
    const [questions, job] = await Promise.all([listWordCreatorQuestions(), getWordCreatorJob()]);
    return NextResponse.json({ questions, job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Không đọc được WordCreator." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { limit?: unknown; source?: unknown; durationSeconds?: unknown; fps?: unknown; autoFps?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Body phải là JSON object." }, { status: 400 });
    }
    const limit = body.limit === undefined ? 10 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return NextResponse.json({ error: "limit phải từ 1 đến 500." }, { status: 400 });
    }
    const source = typeof body.source === "string" ? body.source.trim() : undefined;
    const durationSeconds = body.durationSeconds === undefined ? undefined : Number(body.durationSeconds);
    if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300)) {
      return NextResponse.json({ error: "durationSeconds phải lớn hơn 0 và không quá 300 giây." }, { status: 400 });
    }
    const fps = body.fps === undefined ? 25 : body.fps;
    if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 60) {
      return NextResponse.json({ error: "FPS phải là số nguyên từ 1 đến 60." }, { status: 400 });
    }
    const autoFps = body.autoFps ?? true;
    if (typeof autoFps !== "boolean") return NextResponse.json({ error: "autoFps phải là boolean." }, { status: 400 });
    const job = await enqueueWordCreator({ limit, source, durationSeconds, fps, autoFps });
    return NextResponse.json({ job }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Không tạo được WordCreator." }, { status: 500 });
  }
}
