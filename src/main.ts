import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { makeIntakeTrigger } from './intake-trigger.js';
import { buildServer } from './server.js';
import { createRealGhRunner } from './reviews/gh.js';
import { createRealSdk } from './sessions/sdk.js';
import type { ApnsKeyConfig } from './push/apns.js';

const config = loadConfig(process.env);
const instantIntake = process.env.INTAKE_TRIGGER !== '0';
if (config.sessionsToken === undefined) {
  console.warn('SESSIONS_TOKEN unset — coding-surface sessions API disabled (BI-C1)');
}
// BI-C3: direct-APNs push — key material read once at startup; unset ⇒ no-op.
let apns: ApnsKeyConfig | undefined;
if (config.apns !== undefined) {
  apns = {
    privateKey: readFileSync(config.apns.keyPath, 'utf-8'),
    keyId: config.apns.keyId,
    teamId: config.apns.teamId,
    topic: config.apns.topic,
    ...(config.apns.endpoint !== undefined ? { endpoint: config.apns.endpoint } : {}),
  };
} else {
  console.warn('APNS_KEY_PATH unset — session pushes disabled (BI-C3)');
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
          ...(apns !== undefined ? { apns } : {}),
          reviews: {
            org: config.reviewsOrg,
            checkoutRoot: config.reviewsCheckoutRoot,
            gh: createRealGhRunner(),
          },
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
