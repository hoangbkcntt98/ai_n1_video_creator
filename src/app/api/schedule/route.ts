import { deleteDailySchedule, getDailySchedule, startScheduler, updateDailySchedule } from "@/lib/scheduler";

export const runtime = "nodejs";

export async function GET() {
  try {
    startScheduler();
    return Response.json({ schedule: await getDailySchedule() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read daily schedule.";
    return Response.json({ error: message }, { status: message === "Daily schedule is not configured." ? 404 : 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      enabled?: unknown;
      runTime?: unknown;
      timezone?: unknown;
      forceRecreate?: unknown;
      publishToFacebook?: unknown;
      publishToYouTube?: unknown;
      youtubePrivacy?: unknown;
      youtubeMadeForKids?: unknown;
      youtubeContainsSyntheticMedia?: unknown;
    };
    if (typeof body.enabled !== "boolean" || typeof body.runTime !== "string" || typeof body.timezone !== "string") {
      return Response.json({ error: "Invalid daily schedule settings." }, { status: 400 });
    }
    if (body.publishToYouTube !== undefined && typeof body.publishToYouTube !== "boolean") {
      return Response.json({ error: "Publish to YouTube must be a boolean." }, { status: 400 });
    }
    startScheduler();
    const schedule = await updateDailySchedule({
      enabled: body.enabled,
      runTime: body.runTime,
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
    return Response.json({ error: error instanceof Error ? error.message : "Could not save daily schedule." }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    await deleteDailySchedule();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not delete daily schedule." }, { status: 400 });
  }
}
