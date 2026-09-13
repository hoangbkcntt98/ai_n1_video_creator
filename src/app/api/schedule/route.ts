import { deletePipelineSchedule, getPipelineSchedule, startScheduler, updatePipelineSchedule, validateScheduleMode } from "@/lib/scheduler";

export const runtime = "nodejs";

function requestMode(request: Request) {
  const mode = new URL(request.url).searchParams.get("mode");
  return mode === null ? null : validateScheduleMode(mode);
}

export async function GET(request: Request) {
  let mode;
  try {
    mode = requestMode(request) ?? "daily";
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
  try {
    startScheduler();
    return Response.json({ schedule: await getPipelineSchedule(mode) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read schedule.";
    return Response.json({ error: message }, { status:
      message === "Daily schedule is not configured." || message === "Interval schedule is not configured." ? 404 : 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      enabled?: unknown;
      mode?: unknown;
      startsAt?: unknown;
      intervalHours?: unknown;
      videosPerRun?: unknown;
      runTime?: unknown;
      timezone?: unknown;
      forceRecreate?: unknown;
      publishToFacebook?: unknown;
      publishToYouTube?: unknown;
      youtubePrivacy?: unknown;
      youtubeMadeForKids?: unknown;
      youtubeContainsSyntheticMedia?: unknown;
    };
    const targetMode = requestMode(request);
    const mode = validateScheduleMode(body.mode ?? targetMode ?? "daily");
    if (body.mode === null || (targetMode !== null && targetMode !== mode)) {
      return Response.json({ error: "Schedule mode does not match request." }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean" || typeof body.timezone !== "string" ||
        (mode !== "interval" && typeof body.runTime !== "string") ||
        (body.runTime !== undefined && typeof body.runTime !== "string")) {
      return Response.json({ error: "Invalid schedule settings." }, { status: 400 });
    }
    if (body.publishToYouTube !== undefined && typeof body.publishToYouTube !== "boolean") {
      return Response.json({ error: "Publish to YouTube must be a boolean." }, { status: 400 });
    }
    startScheduler();
    const schedule = await updatePipelineSchedule({
      enabled: body.enabled,
      mode,
      startsAt: body.startsAt,
      intervalHours: body.intervalHours,
      videosPerRun: body.videosPerRun,
      runTime: typeof body.runTime === "string" ? body.runTime : "09:00",
      timezone: body.timezone,
      forceRecreate: body.forceRecreate === true,
      publishToFacebook: body.publishToFacebook === true,
      publishToYouTube: body.publishToYouTube === true,
      youtubePrivacy: body.youtubePrivacy,
      youtubeMadeForKids: body.youtubeMadeForKids,
      youtubeContainsSyntheticMedia: body.youtubeContainsSyntheticMedia,
    });
    return Response.json({ schedule });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not save schedule." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    await deletePipelineSchedule(requestMode(request) ?? "daily");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not delete schedule." }, { status: 400 });
  }
}
