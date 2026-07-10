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
    expect(loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault })).toEqual({
      brainRoot: root,
      vaultRoot: vault,
      port: 8787,
      bind: '127.0.0.1',
    });
  });

  test('PORT and BIND override the defaults', () => {
    const root = tmpBrain();
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(loadConfig({ BRAIN_ROOT: root, VAULT_ROOT: vault, PORT: '9000', BIND: '100.64.0.7' })).toEqual({
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

test('WHISPER_CMD flows through; absent or empty leaves it unset', () => {
  const root = tmpBrain();
  expect(loadConfig({ BRAIN_ROOT: root, WHISPER_CMD: 'whisper-ctranslate2 --model base {input}' }).whisperCmd).toBe(
    'whisper-ctranslate2 --model base {input}',
  );
  expect(loadConfig({ BRAIN_ROOT: root }).whisperCmd).toBeUndefined();
  expect(loadConfig({ BRAIN_ROOT: root, WHISPER_CMD: '' }).whisperCmd).toBeUndefined();
});
