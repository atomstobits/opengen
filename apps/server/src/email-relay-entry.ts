import { Pool } from 'pg';
import {
  buildEmailRelayApp,
  createResendHttpTransport,
  initializeEmailRelaySchema,
  readEmailRelayConfiguration,
} from './email-relay.js';

const config = readEmailRelayConfiguration(process.env);
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.MR_DATABASE_POOL_SIZE ?? 4),
});
await initializeEmailRelaySchema(pool);

const app = await buildEmailRelayApp({
  pool,
  publicOrigin: config.publicOrigin,
  authToken: config.authToken,
  fromAddress: config.fromAddress,
  send: createResendHttpTransport({
    apiKey: config.resendApiKey,
    endpoint: config.resendEndpoint,
  }),
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4315),
});
