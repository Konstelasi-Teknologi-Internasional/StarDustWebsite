/**
 * Static export: `npm run build` produces `out/`, a folder of plain files that
 * any static host can serve. Nothing here may depend on a Node runtime.
 *
 * `trailingSlash` is functional rather than cosmetic. It emits every route as
 * `<route>/index.html`, which is what lets a plain file server resolve a route
 * through its normal index lookup; without it a route emits as `<route>.html`
 * and only resolves for visitors who type the extension themselves.
 *
 * There is deliberately no `basePath`: the site is served from the domain
 * root. Set one only if it ever moves into a subdirectory.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
