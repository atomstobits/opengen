import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  transpilePackages: ['@media-router/catalog', '@media-router/contracts'],
  poweredByHeader: false,
  experimental: {
    agentUpgrade: 'security',
  },
};
export default nextConfig;
