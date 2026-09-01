import Link from "next/link";
import AppSwitcher from "@/components/AppSwitcher";
import { getGrammarPatterns } from "@/lib/dashboard";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatStatus(status: string) {
  return status.replaceAll("_", " ");
}

export default async function PatternsPage() {
  let patterns: Awaited<ReturnType<typeof getGrammarPatterns>> = [];
  let error = "";
  try { patterns = await getGrammarPatterns(); } catch { error = "Không đọc được grammar_patterns. Kiểm tra PostgreSQL và DATABASE_URL."; }
  return <main className={styles.page}><header className={styles.header}><div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>JLPT N1 · Facebook Reels</small></div></div><nav className={styles.actions}><Link href="/">Dashboard</Link><AppSwitcher /></nav></header>
    <section className={styles.content}><div className={styles.heading}><div><p className="eyebrow">GRAMMAR_PATTERNS</p><h1>Danh sách mẫu ngữ pháp</h1><p>ID tăng dần. Chọn mẫu từ Dashboard để chạy lại pipeline.</p></div><strong>{patterns.length} mẫu</strong></div>
      {error ? <p className={styles.error}>{error}</p> : <div className={styles.tableWrap}><table><thead><tr><th>ID</th><th>Mẫu ngữ pháp</th><th>Trạng thái</th><th>Cập nhật</th></tr></thead><tbody>{patterns.map((pattern) => <tr key={pattern.id}><td>#{pattern.id}</td><td>{pattern.pattern}</td><td><span className={`${styles.status} ${styles[pattern.processingStatus] || ""}`}>{formatStatus(pattern.processingStatus)}</span></td><td>{pattern.updatedAt ? new Date(pattern.updatedAt).toLocaleString("vi-VN") : "—"}</td></tr>)}</tbody></table></div>}
    </section>
  </main>;
}
