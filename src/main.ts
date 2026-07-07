import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env);
const app = buildServer({ brainRoot: config.brainRoot });

app
  .listen({ port: config.port, host: config.bind })
  .then((addr) => {
    console.log(`brain-intake API on ${addr} → brain: ${config.brainRoot}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
