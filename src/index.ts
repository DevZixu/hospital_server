import { app } from './app';
import { config } from './config/config';
import { db, prisma } from './config/database';

const server = app.listen(config.port, () => {
  console.log(`Hospital API listening on port ${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received; shutting down`);
  server.close(async (error) => {
    if (error) {
      console.error('HTTP server shutdown failed:', error);
      process.exitCode = 1;
    }

    await Promise.allSettled([prisma.$disconnect(), db.close()]);
    process.exit();
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));