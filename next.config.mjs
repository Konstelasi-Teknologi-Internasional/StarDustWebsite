/**
 * Static export, so the whole site is a folder of files that GitHub Pages
 * (or any bucket) can serve with no Node runtime.
 *
 * NEXT_PUBLIC_BASE_PATH is set by the Pages workflow to "/StarDustWebsite"
 * when publishing to the default github.io subpath. Leave it unset for a
 * custom domain or for local `next dev`.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
