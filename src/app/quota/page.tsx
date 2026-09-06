import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import LogoutButton from "@/components/LogoutButton";
import QuotaChecker from "@/components/QuotaChecker";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default function QuotaPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>JLPT N1 · Facebook Reels</small></div></div>
        <nav className={styles.actions}>
          <Link href="/">Dashboard</Link>
          <Link href="/patterns">Grammar Patterns</Link>
          <Link href="/studio">Video Studio</Link>
          <Link href="/library">Library</Link>
          <AppSwitcher />
          <LogoutButton />
        </nav>
      </header>
      <section className={styles.content}>
        <div className={styles.heading}>
          <div>
            <p className="eyebrow">CODEX QUOTA</p>
            <h1>Quota Checker</h1>
            <p>Paste JSON output from your Codex quota command to inspect active accounts and reset times.</p>
          </div>
        </div>
        <QuotaChecker />
      </section>
    </main>
  );
}
