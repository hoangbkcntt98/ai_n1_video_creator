import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import LogoutButton from "@/components/LogoutButton";
import WordCreator from "@/components/WordCreator";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default function WordCreatorPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>WordCreator · Anki AI notes</small></div></div>
      <nav className={styles.actions}><Link href="/">Dashboard</Link><Link href="/studio">Video Studio</Link><Link href="/library">Library</Link><AppSwitcher /><LogoutButton /></nav>
    </header>
    <section className={styles.content}>
      <div className={styles.heading}><div><p className="eyebrow">WORDCREATOR</p><h1>Tạo câu hỏi đọc Kanji</h1><p>Lấy RequiredVocabulary từ database anki, gọi AI tạo đáp án, sinh file HTML từ template.html.</p></div><span className={styles.badge}>ANKI + AI</span></div>
      <WordCreator />
    </section>
  </main>;
}
