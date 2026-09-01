import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/video-creator",
  env: { NEXT_PUBLIC_BASE_PATH: "/video-creator" },
  serverExternalPackages: ["pg"],
};

export default nextConfig;
