import { loadConfig } from './config.js';
import { makeIntakeTrigger } from './intake-trigger.js';
import { buildServer } from './server.js';
import { createRealSdk } from './sessions/sdk.js';

const config = loadConfig(process.env);
const instantIntake = process.env.INTAKE_TRIGGER !== '0';
if (config.sessionsToken === undefined) {
  console.warn('SESSIONS_TOKEN unset — coding-surface sessions API disabled (BI-C1)');
}
const app = buildServer({
  brainRoot: config.brainRoot,
  vaultRoot: config.vaultRoot,
  ...(config.whisperCmd !== undefined ? { whisperCmd: config.whisperCmd } : {}),
  ...(instantIntake
    ? { intakeTrigger: makeIntakeTrigger({ brainRoot: config.brainRoot }) }
    : {}),
  ...(config.sessionsToken !== undefined
    ? {
        sessions: {
          sessionsDir: config.sessionsDir,
          repoAllowlist: config.repoAllowlist,
          bashAllowlist: config.bashAllowlist,
          approvalTimeoutMin: config.approvalTimeoutMin,
          token: config.sessionsToken,
          models: config.sessionModels,
          efforts: config.sessionEfforts,
          sdk: createRealSdk(),
        },
      }
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
