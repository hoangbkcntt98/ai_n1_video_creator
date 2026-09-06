export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverAbandonedRuns } = await import("@/lib/db");
    await recoverAbandonedRuns().catch(() => {});
    const { resumeActiveRuns } = await import("@/lib/pipeline");
    await resumeActiveRuns().catch(() => {});
    const { startScheduler } = await import("@/lib/scheduler");
    startScheduler();
  }
}
