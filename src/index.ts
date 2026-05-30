import { buildServer } from "./server.js";
import { config } from "./config.js";
import { initStore } from "./store.js";

const app = buildServer();

async function main(): Promise<void> {
  const loaded = await initStore();
  app.log.info({ conversations: loaded, dataDir: config.DATA_DIR }, "store ready");
  await app.listen({ port: config.PORT, host: config.HOST });
}

// Graceful shutdown so Coolify/Docker stop signals close connections cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      });
  });
}

main().catch((err) => {
  app.log.error({ err }, "failed to start");
  process.exit(1);
});
