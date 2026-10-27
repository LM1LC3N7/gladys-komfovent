// -----------------------------------------------------------------------------
// The integration on the real clock sped up 20 times, against a real TCP
// server on 127.0.0.1 (gladys-testkit) that answers Modbus like the fake
// unit and accepts one client at a time, with /data in a real temporary
// directory. The polling period is measured (start to start), the stop goes
// over a real socket, and the state file is the real one.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { KomfoventApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { fileStore } from '../src/store.js';
import { defaultMap, frameAnswer } from './fixtures/fakeKomfovent.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'komfovent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('real clock x20: the period is the interval, start to start; the stop over a real socket', async (t) => {
  const regs = defaultMap();
  const device = await tcpServer({
    singleClient: true,
    latencyMs: 2,
    onData: (chunk) => frameAnswer(regs, chunk),
  });
  t.after(() => device.close());
  const dir = await tempDir(t);
  const clock = realClock({ speed: 20 });
  t.after(() => clock.close());
  const config = { host: `127.0.0.1:${device.port}`, poll_interval: 30 };
  const gladys = createFakeGladys({ config });
  const app = new KomfoventApp({
    gladys,
    logger: quiet,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store: fileStore(join(dir, 'state.json')),
  });
  t.after(() => app.stop({ shutdown: true }));
  registerHandlers(gladys, app, quiet);
  const spy = spyOn(app, 'run', clock);
  await app.boot();
  await gladys.connect();
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.equal(device.peak, 1, 'one connection at a time');
  assert.equal(device.refused, 0);
  // The stop, over the real socket.
  const ack = await gladys.fake.setValue(
    { external_id: 'ext:test-integration:komfovent:unit' },
    { external_id: 'ext:test-integration:komfovent:unit:stop' },
    1,
  );
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(regs.get(1), 0);
  // The confirmation is written in the background (a stop never waits for /data).
  let kept;
  for (let i = 0; i < 50; i += 1) {
    kept = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    if (kept.stopGuard?.pending === false) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(kept.stopGuard.pending, false);
  assert.equal(kept.stopGuard.port, device.port);
  assert.equal(((await stat(join(dir, 'state.json'))).mode & 0o777).toString(8), '600');
});

test('fileStore: no file is null, an unreadable or corrupt file throws, a round trip', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ lastAttemptAt: 1 });
  assert.deepEqual(await store.load(), { lastAttemptAt: 1 });
  await writeFile(path, '{not json');
  await assert.rejects(store.load(), /not JSON/);
  await writeFile(path, 'x'.repeat(5000));
  await assert.rejects(store.load(), /too large/);
  await assert.rejects(fileStore(dir).load(), /unreadable/, 'a directory: unreadable, not empty');
});
