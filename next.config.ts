import type { NextConfig } from 'next'

/**
 * podstart ships as a fully static bundle so it can live on GitHub Pages.
 * There is no server: Supabase is the entire backend, and every byte of DSP,
 * mixing and encoding happens in the browser.
 *
 * BASE_PATH must match the repo name when served from <user>.github.io/<repo>.
 * Set it in the GitHub Actions workflow (or leave empty for a custom domain).
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

const nextConfig: NextConfig = {
  output: 'export',
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  // Capture, DSP and encoding are hard-pinned to the browser; never prerender them.
  experimental: { optimizePackageImports: ['@supabase/supabase-js'] },
}

export default nextConfig
