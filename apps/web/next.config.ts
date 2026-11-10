import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  transpilePackages: ['@media-router/catalog', '@media-router/contracts'],
  poweredByHeader: false,
};
export default nextConfig;
