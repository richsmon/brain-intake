import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

function tmpBrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'brain-'));
  mkdirSync(join(root, 'inbox'));
  return root;
}

describe('loadConfig', () => {
  test('BRAIN_ROOT is required', () => {
    expect(() => loadConfig({})).toThrow(/BRAIN_ROOT/);
  });

  test('BRAIN_ROOT must exist; the vault inbox is auto-created (IN-5)', () => {
    expect(() => loadConfig({ BRAIN_ROOT: '/nope/definitely-missing' })).toThrow(/exist/);
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const cfg = loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault });
    expect(cfg.vaultRoot).toBe(vault);
    expect(existsSync(join(vault, 'inbox'))).toBe(true);
  });

  test('defaults: port 8787, bind 127.0.0.1', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault })).toMatchObject({
      brainRoot: root,
      vaultRoot: vault,
      port: 8787,
      bind: '127.0.0.1',
    });
  });

  test('PORT and BIND override the defaults', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault, PORT: '9000', BIND: '100.64.0.7' })).toMatchObject({
      brainRoot: root,
      vaultRoot: vault,
      port: 9000,
      bind: '100.64.0.7',
    });
  });

  test('non-numeric PORT → error', () => {
    expect(() => loadConfig({ BRAIN_ROOT: tmpBrain(), PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('sessions config (BI-C1)', () => {
  test('defaults: sessionsDir under vault, empty repo allowlist, bash allowlist, 30 min timeout', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const cfg = loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault });
    expect(cfg.sessionsDir).toBe(join(vault, 'sessions'));
    expect(existsSync(cfg.sessionsDir)).toBe(true);
    expect(cfg.repoAllowlist).toEqual({});
    expect(cfg.bashAllowlist).toContain('git status');
    expect(cfg.bashAllowlist).toContain('git diff');
    expect(cfg.bashAllowlist).toContain('git log');
    expect(cfg.bashAllowlist).toContain('ls');
    expect(cfg.approvalTimeoutMin).toBe(30);
    expect(cfg.sessionsToken).toBeUndefined();
  });

  test('SESSIONS_DIR override is created; REPO_ALLOWLIST parses name=path pairs', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const sessions = join(mkdtempSync(join(tmpdir(), 'sess-')), 'deep');
    const repoA = mkdtempSync(join(tmpdir(), 'repo-'));
    const repoB = mkdtempSync(join(tmpdir(), 'repo-'));
    const cfg = loadConfig({
      BRAIN_ROOT: root,
      VAULT_ROOT: vault,
      SESSIONS_DIR: sessions,
      REPO_ALLOWLIST: `gotam=${repoA},brain-intake=${repoB}`,
    });
    expect(cfg.sessionsDir).toBe(sessions);
    expect(existsSync(sessions)).toBe(true);
    expect(cfg.repoAllowlist).toEqual({ gotam: repoA, 'brain-intake': repoB });
  });

  test('REPO_ALLOWLIST entries must exist on disk and be name=path shaped', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(() =>
      loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault, REPO_ALLOWLIST: 'gotam=/nope/missing-checkout' }),
    ).toThrow(/gotam/);
    expect(() =>
      loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault, REPO_ALLOWLIST: 'just-a-name' }),
    ).toThrow(/REPO_ALLOWLIST/);
  });

  test('BASH_ALLOWLIST, APPROVAL_TIMEOUT_MIN and SESSIONS_TOKEN overrides', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const cfg = loadConfig({
      BRAIN_ROOT: root,
      VAULT_ROOT: vault,
      BASH_ALLOWLIST: 'git status, npm test',
      APPROVAL_TIMEOUT_MIN: '5',
      SESSIONS_TOKEN: 'secret-token',
    });
    expect(cfg.bashAllowlist).toEqual(['git status', 'npm test']);
    expect(cfg.approvalTimeoutMin).toBe(5);
    expect(cfg.sessionsToken).toBe('secret-token');
  });

  test('non-numeric or non-positive APPROVAL_TIMEOUT_MIN → error', () => {
    const root = tmpBrain();
    expect(() => loadConfig({ BRAIN_ROOT: root, APPROVAL_TIMEOUT_MIN: 'abc' })).toThrow(/APPROVAL_TIMEOUT_MIN/);
    expect(() => loadConfig({ BRAIN_ROOT: root, APPROVAL_TIMEOUT_MIN: '0' })).toThrow(/APPROVAL_TIMEOUT_MIN/);
  });
});

describe('session picker config (BI-C2)', () => {
  test('defaults: Fable/Opus/Sonnet/Haiku models + five effort levels', () => {
    const root = tmpBrain();
    const cfg = loadConfig({ BRAIN_ROOT: root });
    expect(cfg.sessionModels.map((m) => m.label)).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku']);
    expect(cfg.sessionModels[0]).toEqual({ id: 'claude-fable-5', label: 'Fable' });
    expect(cfg.sessionEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('SESSION_MODELS and SESSION_EFFORTS override the defaults', () => {
    const root = tmpBrain();
    const cfg = loadConfig({
      BRAIN_ROOT: root,
      SESSION_MODELS: 'claude-sonnet-5=Sonnet, claude-haiku-4-5=Haiku',
      SESSION_EFFORTS: 'low, high',
    });
    expect(cfg.sessionModels).toEqual([
      { id: 'claude-sonnet-5', label: 'Sonnet' },
      { id: 'claude-haiku-4-5', label: 'Haiku' },
    ]);
    expect(cfg.sessionEfforts).toEqual(['low', 'high']);
  });

  test('malformed SESSION_MODELS → error', () => {
    const root = tmpBrain();
    expect(() => loadConfig({ BRAIN_ROOT: root, SESSION_MODELS: 'just-an-id' })).toThrow(/SESSION_MODELS/);
  });
});

test('WHISPER_CMD flows through; absent or empty leaves it unset', () => {
  const root = tmpBrain();
  expect(loadConfig({ BRAIN_ROOT: root, WHISPER_CMD: 'whisper-ctranslate2 --model base {input}' }).whisperCmd).toBe(
    'whisper-ctranslate2 --model base {input}',
  );
  expect(loadConfig({ BRAIN_ROOT: root }).whisperCmd).toBeUndefined();
  expect(loadConfig({ BRAIN_ROOT: root, WHISPER_CMD: '' }).whisperCmd).toBeUndefined();
});

describe('review surface config (MC-R1)', () => {
  test('defaults: market-clue org, checkouts under ~/code/market-clue', () => {
    const root = tmpBrain();
    const cfg = loadConfig({ BRAIN_ROOT: root });
    expect(cfg.reviewsOrg).toBe('market-clue');
    expect(cfg.reviewsCheckoutRoot.endsWith(join('code', 'market-clue'))).toBe(true);
  });

  test('MC-R2 defaults: richsmon personal repos, checkouts under ~/code', () => {
    const root = tmpBrain();
    const cfg = loadConfig({ BRAIN_ROOT: root });
    expect(cfg.reviewsOwnUser).toBe('richsmon');
    expect(cfg.reviewsOwnRoot.endsWith('code')).toBe(true);
    expect(cfg.reviewsOwnRoot.endsWith(join('code', 'market-clue'))).toBe(false);
  });

  test('REVIEWS_ORG and REVIEWS_CHECKOUT_ROOT override the defaults', () => {
    const root = tmpBrain();
    const cfg = loadConfig({
      BRAIN_ROOT: root,
      REVIEWS_ORG: 'acme',
      REVIEWS_CHECKOUT_ROOT: '/srv/checkouts',
    });
    expect(cfg.reviewsOrg).toBe('acme');
    expect(cfg.reviewsCheckoutRoot).toBe('/srv/checkouts');
  });

  test('REVIEWS_OWN_USER and REVIEWS_OWN_ROOT override the MC-R2 defaults', () => {
    const root = tmpBrain();
    const cfg = loadConfig({
      BRAIN_ROOT: root,
      REVIEWS_OWN_USER: 'someone-else',
      REVIEWS_OWN_ROOT: '/srv/own',
    });
    expect(cfg.reviewsOwnUser).toBe('someone-else');
    expect(cfg.reviewsOwnRoot).toBe('/srv/own');
  });
});
