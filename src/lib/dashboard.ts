import { listRuns, type Run } from "@/lib/pipeline";
import { query } from "@/lib/db";

export type GrammarPattern = { id: number; pattern: string; processingStatus: string; updatedAt: string | null };

export async function getGrammarPatterns(): Promise<GrammarPattern[]> {
  const result = await query<{ id: number; pattern: string; processing_status: string; updated_at: string | null }>(
    `SELECT id, pattern, COALESCE(processing_status, 'pending') AS processing_status, updated_at
     FROM grammar_patterns ORDER BY id ASC LIMIT 1000`
  );
  return result.rows.map((row) => ({ id: row.id, pattern: row.pattern, processingStatus: row.processing_status, updatedAt: row.updated_at }));
}

export async function getDashboard() {
  const warnings: string[] = [];
  const [patterns, runs] = await Promise.all([
    getGrammarPatterns().catch(() => { warnings.push("Không đọc được grammar_patterns. Kiểm tra PostgreSQL và DATABASE_URL."); return [] as GrammarPattern[]; }),
    listRuns().catch(() => { warnings.push("Không đọc được lịch sử pipeline. Kiểm tra PostgreSQL và DATABASE_URL."); return [] as Run[]; }),
  ]);
  return { patterns, runs, warnings };
}
