// Instant intake: capture should not wait for the 07:00 loop. After an item
// lands (and, for voice, after its transcript exists) the server fires one
// detached `brain-loop run --intake-only` pass in the brain repo. The loop's
// own rails still apply (caps, kill switch, dedup); the morning run stays the
// sweeper for anything missed. A latch keeps at most one pass running; a
// capture arriving mid-pass schedules exactly one re-run.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface IntakeTrigger {
  fire(): void;
}

interface ChildLike {
  on(event: 'exit' | 'error', cb: () => void): unknown;
  unref?(): void;
}

export type SpawnFn = (cmd: string, args: string[], opts: object) => ChildLike;

export function makeIntakeTrigger({
  brainRoot,
  spawnFn = spawn as unknown as SpawnFn,
  onError,
}: {
  brainRoot: string;
  spawnFn?: SpawnFn;
  onError?: (err: unknown) => void;
}): IntakeTrigger {
  let running = false;
  let rerunQueued = false;

  const launch = () => {
    running = true;
    let child: ChildLike;
    try {
      child = spawnFn(
        'python3',
        [join(brainRoot, 'tools', 'brain-loop', 'run.py'), 'run', '--intake-only'],
        { cwd: brainRoot, stdio: 'ignore' },
      );
    } catch (err) {
      running = false;
      onError?.(err);
      return;
    }
    const done = () => {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        launch();
      }
    };
    child.on('exit', done);
    child.on('error', done);
    child.unref?.();
  };

  return {
    fire() {
      if (running) {
        rerunQueued = true;
        return;
      }
      launch();
    },
  };
}
