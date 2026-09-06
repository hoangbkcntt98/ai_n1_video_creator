import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import LogoutButton from "@/components/LogoutButton";
import VideoStudio from "@/components/VideoStudio";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default function StudioPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>JLPT N1 · Facebook Reels</small></div></div>
      <nav className={styles.actions}><Link href="/">Dashboard</Link><Link href="/patterns">Grammar Patterns</Link><Link href="/library">Library</Link><Link href="/quota">Codex Quota</Link><AppSwitcher /><LogoutButton /></nav>
    </header>
    <section className={styles.content}>
      <div className={styles.heading}><div><p className="eyebrow">VIDEO STUDIO</p><h1>Combine Images and Audio into Video</h1><p>Upload images, add audio, or create voiceovers with TTS, then export vertical 1080 × 1920 MP4.</p></div><span className={styles.badge}>FFMPEG</span></div>
      <VideoStudio />
    </section>
  </main>;
}
