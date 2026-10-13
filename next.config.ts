import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it out of the bundle (also removes a "Critical dependency" build warning).
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
