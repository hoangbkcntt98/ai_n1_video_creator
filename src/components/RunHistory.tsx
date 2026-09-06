"use client";

import { useEffect, useState } from "react";
import type { Run } from "@/lib/pipeline";
import SchedulePicker from "./SchedulePicker";
import styles from "./RunHistory.module.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

type LogState = { text: string; error?: string; loading: boolean };

function formatRunName(run: Run) {
  return run.pattern_name ? `${run.pattern_name} (#${run.pattern_id})` : run.action === "publish" ? "Facebook upload" : "Pipeline next pattern";
}

export default function RunHistory({ runs }: { runs: Run[] }) {
  const [logs, setLogs] = useState<Record<number, LogState>>({});
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const [videosData, setVideoData] = useState<Record<string, { caption: string; title: string; scheduledAt: string }>>({});

  async function loadLog(runId: number) {
    setLogs((current) => ({ ...current, [runId]: { text: current[runId]?.text || "", loading: true } }));
    try {
      const response = await fetch(`${basePath}/api/runs/${runId}/log`, { cache: "no-store" });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) throw new Error("Log endpoint returned invalid data.");
      const payload = await response.json() as { log?: string; error?: string; run?: { output_video?: string } };
      if (!response.ok) throw new Error(payload.error || "Could not read log.");
      setLogs((current) => ({ ...current, [runId]: { text: payload.log || "No log data yet.", loading: false } }));
      
      // Load caption if videos exists
      if (payload.run?.output_video) {
        await loadCaptionFromVideoPath(payload.run.output_video);
      }
    } catch (error) {
      setLogs((current) => ({ ...current, [runId]: { text: "", error: error instanceof Error ? error.message : "Could not read log.", loading: false } }));
    }
  }

  async function loadCaptionFromVideoPath(videosPath: string) {
    if (videosData[videosPath]) return;
    
    // Extract pattern name from videos path: "20260901/pattern_name_videos.mp4" -> "pattern_name"
    const match = videosPath.match(/\d{8}\/(.+)_video\.mp4$/);
    if (!match) return;
    
    const patternName = match[1];
    try {
      const response = await fetch(`${basePath}/api/caption/${encodeURIComponent(patternName)}`);
      const body = await response.json() as { caption?: string; error?: string };
      if (response.ok) {
        setVideoData(current => ({
          ...current,
          [videosPath]: {
            caption: current[videosPath]?.caption || body.caption || "",
            title: current[videosPath]?.title || patternName.replace(/_/g, " "),
            scheduledAt: current[videosPath]?.scheduledAt || "",
          }
        }));
      }
    } catch {
      // Ignore
    }
  }

  function toggleRun(runId: number, videosPath?: string | null) {
    const willExpand = !expandedRuns.has(runId);
    setExpandedRuns(current => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
    if (willExpand && videosPath) void loadCaptionFromVideoPath(videosPath);
  }

  async function saveVideoDetails(videosPath: string) {
    const data = videosData[videosPath];
    if (!data) return;
    
    try {
      const response = await fetch(`${basePath}/api/videos`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: videosPath, title: data.title, caption: data.caption })
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not save.");
      alert("Saved.");
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not save video.");
    }
  }

  async function publishToFacebook(videosPath: string, schedule = false) {
    const data = videosData[videosPath];
    if (!data?.caption?.trim()) {
      alert("Enter a caption before publishing to Facebook.");
      return;
    }
    let scheduledAt: string | undefined;
    if (schedule) {
      if (!data.scheduledAt) {
        alert("Choose a publishing time.");
        return;
      }
      const date = new Date(data.scheduledAt);
      if (Number.isNaN(date.getTime())) {
        alert("Invalid scheduled time.");
        return;
      }
      scheduledAt = date.toISOString();
    } else if (!window.confirm("Publish this video to the Facebook Page now?")) return;
    
    try {
      const response = await fetch(`${basePath}/api/videos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish", path: videosPath, title: data.title,
          caption: data.caption, scheduledAt, confirmPublish: true,
        })
      });
      const body = await response.json() as { error?: string; run?: { id: number } };
      if (!response.ok) throw new Error(body.error || "Could not publish.");
      alert(schedule ? `Facebook schedule created in run #${body.run?.id}.` : `Created Facebook upload run #${body.run?.id}.`);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Facebook publishing failed.");
    }
  }

  useEffect(() => {
    const activeRuns = runs.filter((run) => run.status === "running");
    activeRuns.forEach((run) => { void loadLog(run.id); });
    if (!activeRuns.length) return;
    const interval = window.setInterval(() => activeRuns.forEach((run) => { void loadLog(run.id); }), 1500);
    return () => window.clearInterval(interval);
  }, [runs]);

  // Preload generated title/caption for completed videos so the editable form
  // is ready immediately when a Run is opened.
  useEffect(() => {
    runs
      .filter((run) => run.status === "success" && run.output_video)
      .forEach((run) => { void loadCaptionFromVideoPath(run.output_video!); });
  }, [runs]);

  // Auto-expand running runs
  useEffect(() => {
    const running = runs.filter(r => r.status === "running").map(r => r.id);
    if (running.length > 0) {
      setExpandedRuns(current => new Set([...current, ...running]));
    }
  }, [runs]);

  if (!runs.length) return <p className={styles.empty}>No runs yet. New pipeline runs appear here.</p>;

  return (
    <div className={styles.list}>
      {runs.map((run) => {
        const log = logs[run.id];
        const isExpanded = expandedRuns.has(run.id);
        const hasVideo = run.status === "success" && run.output_video;
        
        return (
          <article className={styles.run} key={run.id}>
            <div className={styles.summary} onClick={() => toggleRun(run.id, run.output_video)}>
              <span className={`${styles.status} ${styles[run.status]}`}>{run.status}</span>
              <div className={styles.summaryContent}>
                <strong>#{run.id} · {run.action}</strong>
                <p>{formatRunName(run)}</p>
                {run.error ? <p className={styles.errorText}>{run.error}</p> : null}
              </div>
              <time>{new Date(run.started_at).toLocaleString("en-US")}</time>
              <span className={styles.toggleIcon}>{isExpanded ? "▼" : "▶"}</span>
            </div>
            
            {isExpanded && (
              <div className={styles.expandedContent}>
                {/* Video preview section */}
                {hasVideo && (
                  <div className={styles.videoSection}>
                    <h3>Video Output</h3>
                    <video 
                      controls 
                      className={styles.videoPlayer}
                      src={`${basePath}/api/videos/${encodeURIComponent(btoa(unescape(encodeURIComponent(run.output_video || ""))).replaceAll("/", "_").replaceAll("+", "-"))}`}
                    >
                      Browser does not support videos.
                    </video>
                    
                    <div className={styles.videoForm}>
                      <label>
                        Title
                        <input
                          type="text"
                          value={videosData[run.output_video!]?.title || ""}
                          onChange={(e) => setVideoData(current => ({
                          ...current,
                            [run.output_video!]: {
                              title: e.target.value,
                              caption: current[run.output_video!]?.caption || "",
                              scheduledAt: current[run.output_video!]?.scheduledAt || "",
                            }
                          }))}
                          maxLength={300}
                        />
                      </label>
                      <label>
                        Facebook Caption
                        <textarea
                          value={videosData[run.output_video!]?.caption || ""}
                          onChange={(e) => setVideoData(current => ({
                          ...current,
                            [run.output_video!]: {
                              title: current[run.output_video!]?.title || "",
                              caption: e.target.value,
                              scheduledAt: current[run.output_video!]?.scheduledAt || "",
                            }
                          }))}
                          maxLength={5000}
                          rows={4}
                          placeholder="Caption will load from AI automatically..."
                        />
                        </label>
                      <label>
                        Schedule publishing (leave empty to publish now)
                        <SchedulePicker
                          value={videosData[run.output_video!]?.scheduledAt || ""}
                          onChange={(value) => setVideoData(current => ({
                            ...current,
                            [run.output_video!]: {
                              ...current[run.output_video!],
                              title: current[run.output_video!]?.title || "",
                              caption: current[run.output_video!]?.caption || "",
                              scheduledAt: value,
                            }
                          }))}
                        />
                      </label>
                      <div className={styles.videoActions}>
                        <button type="button" onClick={() => saveVideoDetails(run.output_video!)}>Save Content</button>
                        <button type="button" className={styles.facebookBtn} onClick={() => publishToFacebook(run.output_video!)}>Publish to Facebook</button>
                        <button type="button" className={styles.scheduleBtn} onClick={() => publishToFacebook(run.output_video!, true)}>Schedule Facebook Post</button>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Log section */}
                <div className={styles.logArea}>
                  <div className={styles.logTitle}>
                    <strong>Python output</strong>
                    <span>{log?.loading ? "Loading..." : run.status === "running" ? "Auto-refresh every 1.5s" : "Run finished"}</span>
                    <button 
                      type="button" 
                      onClick={(e) => { e.stopPropagation(); void loadLog(run.id); }} 
                      disabled={log?.loading}
                    >
                      Reload
                    </button>
                  </div>
                  {log?.error ? (
                    <p className={styles.logError}>{log.error}</p>
                  ) : (
                    <pre>{log?.text || "Waiting for Python output..."}</pre>
                  )}
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
