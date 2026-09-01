import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import DashboardControls from "@/components/DashboardControls";
import RunHistory from "@/components/RunHistory";
import VideoLibrary from "@/components/VideoLibrary";
import { getDashboard } from "@/lib/dashboard";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const dashboard = await getDashboard();
  return <main className={styles.page}><header className={styles.header}><div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>JLPT N1 · Facebook Reels</small></div></div><nav className={styles.headerActions}><Link href="/patterns">Mẫu ngữ pháp</Link><AppSwitcher /></nav></header>
    <div className={styles.content}>
      <DashboardControls patterns={dashboard.patterns}/>
      {dashboard.warnings.length ? <aside className={styles.warning}>{dashboard.warnings.map((warning) => <p key={warning}>{warning}</p>)}</aside> : null}
      <section className={styles.runSection}><div className={styles.sectionHeading}><div><p className="eyebrow">PIPELINE</p><h2>Lịch sử chạy</h2></div><span>{dashboard.patterns.length} mẫu từ grammar_patterns</span></div><RunHistory runs={dashboard.runs}/></section>
      <VideoLibrary videos={dashboard.videos}/>
    </div>
  </main>;
}
