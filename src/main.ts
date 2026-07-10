import { loadConfig } from './config.js';
import { makeIntakeTrigger } from './intake-trigger.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env);
const instantIntake = process.env.INTAKE_TRIGGER !== '0';
const app = buildServer({
  brainRoot: config.brainRoot,
  vaultRoot: config.vaultRoot,
  ...(config.whisperCmd !== undefined ? { whisperCmd: config.whisperCmd } : {}),
  ...(instantIntake
    ? { intakeTrigger: makeIntakeTrigger({ brainRoot: config.brainRoot }) }
    : {}),
});

app
  .listen({ port: config.port, host: config.bind })
  .then((addr) => {
    console.log(`brain-intake API on ${addr} → brain: ${config.brainRoot} · vault: ${config.vaultRoot}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
