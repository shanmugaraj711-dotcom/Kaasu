import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Kaasu is a fully dynamic dashboard (in-memory store, live PayPal
     status). Component caching is disabled so route handlers stay dynamic. */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
