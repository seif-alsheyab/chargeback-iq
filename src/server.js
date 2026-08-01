// Process entry point.

import { createApp } from './app.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';

const port = Number(process.env.PORT ?? 4010);
const app = createApp();
const server = app.listen(port, () => {
  logger.info('server started', { port, env: process.env.NODE_ENV ?? 'development' });
});

/**
 * Graceful shutdown.
 *
 * On SIGTERM, stop accepting new connections, let in-flight requests finish,
 * then close the pool. Exiting immediately would abort a request mid
 * transaction and leave a connection stranded on the server.
 */
function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(async () => {
    await closePool();
    logger.info('shutdown complete');
    process.exit(0);
  });
  // Do not hang forever if a connection refuses to close.
  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
