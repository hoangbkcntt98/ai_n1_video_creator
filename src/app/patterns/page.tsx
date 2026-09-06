import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import LogoutButton from "@/components/LogoutButton";
import PatternVideoButton from "@/components/PatternVideoButton";
import { getGrammarPatterns } from "@/lib/dashboard";
import { listVideos, type VideoRecord } from "@/lib/video";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

export default async function PatternsPage() {
  let patterns: Awaited<ReturnType<typeof getGrammarPatterns>> = [];
  let videos: VideoRecord[] = [];
  let error = "";
  try { patterns = await getGrammarPatterns(); } catch { error = "Could not read grammar_patterns. Check PostgreSQL and DATABASE_URL."; }
  try { videos = await listVideos(); } catch { /* Video action remains available; modal reports missing file. */ }
  function videosFor(patternName: string) {
    return videos.find((videos) => {
      const name = videos.relativePath.split("/").pop()?.replace(/_video\.mp4$/i, "");
      return name === patternName || videos.title === patternName;
    }) || null;
  }
  
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark}>VC</span>
          <div>
            <strong>Video Creator</strong>
            <small>JLPT N1 · Facebook Reels</small>
          </div>
        </div>
        <nav className={styles.actions}>
          <Link href="/">Dashboard</Link>
          <Link href="/studio">Video Studio</Link>
          <Link href="/library">Library</Link>
          <Link href="/quota">Codex Quota</Link>
          <AppSwitcher />
          <LogoutButton />
        </nav>
      </header>
      
      <section className={styles.content}>
        <div className={styles.heading}>
          <div>
            <p className="eyebrow">GRAMMAR_PATTERNS</p>
            <h1>Grammar Pattern List</h1>
            <p>IDs are ordered ascending. Select a pattern from Dashboard to run the pipeline.</p>
          </div>
          <strong>{patterns.length} patterns</strong>
        </div>
        
        {error ? (
          <p className={styles.error}>{error}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Grammar Patterns</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>Facebook / Video</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((pattern) => (
                  <tr key={pattern.id}>
                    <td>#{pattern.id}</td>
                    <td>{pattern.pattern}</td>
                    <td>
                      <span className={`${styles.status} ${styles[pattern.processingStatus] || ""}`}>
                        {formatStatus(pattern.processingStatus)}
                      </span>
                    </td>
                    <td>{pattern.updatedAt ? new Date(pattern.updatedAt).toLocaleString("en-US") : "—"}</td>
                    <td>
                      {videosFor(pattern.pattern) || pattern.processingStatus === "ok" ? (
                        <>
                          <PatternVideoButton patternId={pattern.id} patternName={pattern.pattern} initialVideo={videosFor(pattern.pattern)} />
                          {videosFor(pattern.pattern)?.publishedAt ? <small className={styles.facebookMeta}>Published: {new Date(videosFor(pattern.pattern)!.publishedAt!).toLocaleString("en-US")}</small> : null}
                          {videosFor(pattern.pattern)?.scheduledPublishAt ? <small className={styles.facebookMeta}>Scheduled: {new Date(videosFor(pattern.pattern)!.scheduledPublishAt!).toLocaleString("en-US")}</small> : null}
                        </>
                      ) : (
                        <span style={{ color: "#5b7089", fontSize: 11 }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
