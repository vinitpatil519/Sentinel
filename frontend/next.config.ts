import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The dev-route badge sits on top of the console's status strip.
  devIndicators: false,
};

export default nextConfig;
