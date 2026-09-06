import LoginForm from "@/components/LoginForm";
import styles from "./page.module.css";

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <div className={styles.brand}><span className={styles.mark}>VC</span><div><strong>Video Creator</strong><small>JLPT N1 · Facebook Reels</small></div></div>
        <h1>Log In</h1>
        <p>Log in to create videos, edit captions, and publish to Facebook.</p>
        <LoginForm />
      </section>
    </main>
  );
}
