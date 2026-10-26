import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@prisma/client', 'adm-zip', 'sanitize-html'],
};

export default nextConfig;
