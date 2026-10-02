import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, env: { JWT_SECRET: 'test-secret-test-secret-test-secret' }, testTimeout: 20000 } });
