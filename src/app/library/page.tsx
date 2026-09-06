import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import LogoutButton from "@/components/LogoutButton";
import { getStudioLibrary } from "@/lib/studioLibrary";
import LibraryBrowser from "./LibraryBrowser";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LibraryPage() {
  const library = await getStudioLibrary();
  return <main className={styles.page}>
    <header className={styles.header}><div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>JLPT N1 · Facebook Reels</small></div></div><nav className={styles.actions}><Link href="/">Dashboard</Link><Link href="/studio">Video Studio</Link><Link href="/quota">Codex Quota</Link><AppSwitcher /><LogoutButton /></nav></header>
    <section className={styles.content}>
      <div className={styles.heading}><div><p className="eyebrow">LIBRARY</p><h1>Content Library</h1><p>Used images, audio, and created videos are saved here for review.</p></div><Link className={styles.create} href="/studio">+ Create New Video</Link></div>
      <LibraryBrowser initialLibrary={library} />
    </section>
  </main>;
}
