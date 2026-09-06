import path from "node:path";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Thiếu biến môi trường ${name}.`);
  return value;
}

function asBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

export const appConfig = {
  databaseUrl: () => required("DATABASE_URL").replace(/\\@/g, "@"),
  skillDir: () => process.env.JLPT_N1_SKILL_DIR?.trim() || "/home/opc/openclaw_skill/jlpt-n1",
  dataDir: () => process.env.DATA_DIR?.trim() || "/mnt/openclaw-data/openclaw",
  outputDir: () => process.env.OUTPUT_DIR?.trim() || "/mnt/openclaw-data/openclaw/outputs",
  logDir: () => process.env.LOG_DIR?.trim() || "/mnt/openclaw-data/openclaw",
  pipelineConfig() {
    return {
      llm: {
        baseUrl: required("LLM_BASE_URL"), apiKey: required("LLM_API_KEY"),
        model: required("LLM_MODEL"), temperature: Number(process.env.LLM_TEMPERATURE || 0.7),
        maxTokens: Number(process.env.LLM_MAX_TOKENS || 2000), timeout: Number(process.env.LLM_TIMEOUT || 120),
      },
      image: {
        baseUrl: required("IMAGE_BASE_URL"), apiKey: required("IMAGE_API_KEY"),
        model: required("IMAGE_MODEL"), size: process.env.IMAGE_SIZE || "1024x1024",
        timeout: Number(process.env.IMAGE_TIMEOUT || 600),
      },
      facebook: {
        pageId: required("FACEBOOK_PAGE_ID"), pageToken: required("FACEBOOK_PAGE_TOKEN"),
        autoPublish: asBoolean(process.env.FACEBOOK_AUTO_PUBLISH, false),
      },
      database: { url: this.databaseUrl() },
      paths: {
        dataDir: this.dataDir(), outputDir: this.outputDir(),
        workDir: process.env.WORK_DIR?.trim() || this.skillDir(), logDir: this.logDir(),
      },
      pipeline: {
        forceRecreate: asBoolean(process.env.PIPELINE_FORCE_RECREATE, false),
        skipImageGeneration: asBoolean(process.env.PIPELINE_SKIP_IMAGE_GENERATION, false),
        skipAiCreateIfExists: asBoolean(process.env.PIPELINE_SKIP_AI_CREATE_IF_EXISTS, true),
        skipCreateImageIfExists: asBoolean(process.env.PIPELINE_SKIP_CREATE_IMAGE_IF_EXISTS, true),
        // Facebook publish must only start from explicit dashboard confirmation.
        skipPublish: true,
        logLevel: process.env.PIPELINE_LOG_LEVEL || "INFO",
      },
      tts: { provider: process.env.TTS_PROVIDER || "edge", voice: process.env.TTS_VOICE || "ja-JP-NanamiNeural" },
    };
  },
};

export function resolvedOutputPath(relativePath: string) {
  const root = path.resolve(appConfig.outputDir());
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Đường dẫn video không hợp lệ.");
  return target;
}

export function toRelativeOutputPath(filePath: string) {
  const root = path.resolve(appConfig.outputDir());
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Video nằm ngoài OUTPUT_DIR.");
  return relative.split(path.sep).join("/");
}
