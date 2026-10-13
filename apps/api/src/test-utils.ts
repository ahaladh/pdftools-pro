import { RedisMemoryServer } from 'redis-memory-server';

/**
 * A real Redis for integration tests. Uses, in order: REDIS_URL (e.g. a CI service container),
 * a local binary via REDIS_SERVER_BIN, or redis-memory-server's own download-and-build.
 */
export async function startRedis(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (process.env.REDIS_URL) return { url: process.env.REDIS_URL, stop: async () => undefined };
  const bin = process.env.REDIS_SERVER_BIN;
  const server = new RedisMemoryServer(bin ? { binary: { systemBinary: bin } } : {});
  const host = await server.getHost(), port = await server.getPort();
  return { url: `redis://${host}:${port}`, stop: async () => { await server.stop(); } };
}
