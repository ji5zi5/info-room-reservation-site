import type { NextConfig } from "next";

import { buildSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        headers: [...buildSecurityHeaders(process.env.NODE_ENV === "production" ? "production" : "development")],
        source: "/(.*)"
      }
    ];
  },
  devIndicators: false,
  reactStrictMode: true
};

export default nextConfig;
