// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Komfovent, with
// the exact wiring of the container (src/handlers.js) and a mocked clock. The
// monotonic clock follows the mocked Date and moves 1 µs at every read (a
// decision that reads it twice sees it move).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { KomfoventApp } from '../src/app.js';
import { HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  C8_FIRMWARE,
  HOST,
  NOW,
  UNIT_ID,
  fakeKomfovent,
  settle,
} from './fixtures/fakeKomfovent.js';

const CFG = { host: HOST };
const ALLOW = { host: HOST, allow_commands: true };
const DEVICE = 'ext:test-integration:komfovent:unit';
const UNIT = `${HOST}#${UNIT_ID}`;
const feature = (role) => `${DEVICE}:${role}`;
const STOP = { fc: 6, register: 1, value: 0 };
const START = { fc: 6, register: 1, value: 1 };
const mode = (value) => ({ fc: 6, register: 5, value });

/**
 * A getConfig() that answers the SDK's own resynchronization (the first call,
 * made by connect() before 'connected'), then fails `fails` times (Infinity:
 * always) in the integration's handler.
 */
function flakyConfig(fails, config = CFG) {
  let calls = 0;
  let left = fails;
  const fn = async () => {
    calls += 1;
    if (calls > 1 && left > 0) {
      left -= 1;
      throw new Error('Gladys busy');
    }
    return config;
  };
  fn.calls = () => calls;
  return fn;
}

async function setup(
  t,
  {
    config = CFG,
    unit = fakeKomfovent(),
    store = memoryStore(),
    create = true,
    getConfig,
    boot = false,
  } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  if (getConfig) gladys.getConfig = getConfig;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  let drift = 0;
  const app = new KomfoventApp({
    gladys,
    logger,
    connect: unit.connectFn,
    now: () => Date.now(),
    clock: () => Date.now() + (drift += 0.001),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(3);
    }
  };
  if (boot) {
    await app.boot();
    await settle();
  }
  const connecting = gladys.connect();
  await settle();
  await advance(500);
  await connecting;
  t.after(() => app.stop({ shutdown: true }));
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
    await advance(1100);
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait, 50);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const status = () => gladys.fake.connectionStatus;
  return { gladys, app, unit, advance, logs, fire, press, store, state, status };
}

test('discovery: one device, every value read and published, the exact requests', async (t) => {
  const ctx = await setup(t);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.model, 'Komfovent C6');
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      (f.category === 'button' && f.type === 'push') ||
        (f.category === 'text' && f.type === 'select'),
      `${f.external_id} is writable`,
    );
  }
  const select = device.features.find((f) => f.external_id === feature('mode'));
  assert.deepEqual(
    select.supported_options.map((o) => o.value),
    ['away', 'normal', 'intensive', 'boost'],
  );
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.state('temperature-extract').state, 21.4);
  assert.equal(ctx.state('temperature-outdoor').state, -5.2, 'signed register');
  assert.equal(ctx.state('temperature-panel').state, 21.2);
  assert.equal(ctx.state('humidity-panel').state, 41);
  assert.equal(ctx.state('fan-supply-level').state, 45.5);
  assert.equal(ctx.state('fan-extract-level').state, 47);
  assert.equal(ctx.state('filter-clogging').state, 12);
  assert.equal(ctx.state('heat-exchanger-efficiency').state, 83);
  assert.equal(ctx.state('co2-sensor-1').state, 640);
  assert.equal(ctx.state('humidity-sensor-2').state, 55);
  assert.equal(ctx.state('co2-sensor-2'), undefined, 'sensor 2 is a humidity sensor');
  assert.equal(ctx.state('humidity-sensor-1'), undefined);
  assert.equal(ctx.state('power').state, 1);
  assert.equal(ctx.state('fans-running').state, 1);
  assert.equal(ctx.state('alarm-fault').state, 0);
  assert.equal(ctx.state('alarm-count').state, 0);
  assert.equal(ctx.state('alarm-codes').text, 'none');
  assert.equal(ctx.state('mode').text, 'normal');
  assert.equal(ctx.state('current-mode').text, 'normal');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.fr, /Komfovent C6 : normal/);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.device_external_id ?? badge.external_id, DEVICE);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // The ranges of hass-komfovent, function 3, unit id 254, one connection closed after.
  assert.deepEqual(
    ctx.unit.log.slice(0, 5).map((r) => [r.fc, r.register, r.count, r.uid]),
    [
      [3, 1, 34, 254],
      [3, 900, 56, 254],
      [3, 600, 11, 254],
      [3, 200, 15, 254],
      [3, 1000, 2, 254],
    ],
  );
  assert.equal(ctx.unit.open.size, 0);
  assert.equal(ctx.unit.maxOpen, 1);
  assert.deepEqual(ctx.store.data.identity, { unit: UNIT, controller: 'C6' });
});

test('fans stopped: efficiency and extract sensors not published (unknown), never 0', async (t) => {
  const ctx = await setup(t);
  ctx.unit.regs.set(900, 0);
  ctx.unit.regs.set(924, 0);
  ctx.unit.regs.set(952, 0);
  const before = ctx.gladys.fake.states.length;
  await ctx.advance(MINUTE + 500, 100);
  const later = ctx.gladys.fake.states.slice(before);
  assert.equal(ctx.state('fans-running').state, 0);
  for (const role of ['heat-exchanger-efficiency', 'co2-sensor-1']) {
    assert.ok(
      !later.some((s) => s.device_feature_external_id === feature(role)),
      `${role} not published`,
    );
  }
});

test('alarm codes are a text ("F9, W1"), never a measure', async (t) => {
  const ctx = await setup(t);
  ctx.unit.regs.set(600, 2);
  ctx.unit.regs.set(601, 9);
  ctx.unit.regs.set(602, 0x81);
  ctx.unit.regs.set(900, 4 | 2048 | 4096);
  await ctx.advance(MINUTE + 500, 100);
  assert.equal(ctx.state('alarm-codes').text, 'F9, W1');
  assert.equal(ctx.state('alarm-codes').state, undefined);
  assert.equal(ctx.state('alarm-count').state, 2);
  assert.equal(ctx.state('alarm-fault').state, 1);
  assert.equal(ctx.state('alarm-warning').state, 1);
  assert.match(ctx.status().message.fr, /DÉFAUT/);
});

test('the commands are off by default: mode and start refused, nothing written', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('mode', 'boost');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser les commandes/);
  assert.equal((await ctx.press('start')).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a mode: decided on a fresh read, written in register 5, confirmed by the read back', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  const reads = ctx.unit.reads();
  const ack = await ctx.press('mode', 'intensive');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [mode(3)]);
  assert.ok(ctx.unit.reads() >= reads + 4, 'three fresh reads before, a read back after');
  assert.equal(ctx.state('mode').text, 'intensive');
  // Already so: nothing written, success.
  assert.equal((await ctx.press('mode', 'intensive')).success, true);
  assert.equal(ctx.unit.writes().length, 1);
});

test('the select takes only its values: never off, stand-by, kitchen nor a number', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const bad of ['off', 'standby', 'kitchen', 0, 3, '3', '', null, ' boost', 'Boost']) {
    assert.equal((await ctx.press('mode', bad, 100)).success, false, String(bad));
  }
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a unit off, in stand-by or stopping is never started by a mode', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const [register, value] of [
    [1, 0],
    [5, 0],
    [5, 10],
  ]) {
    ctx.unit.regs.set(1, 1);
    ctx.unit.regs.set(5, 2);
    ctx.unit.regs.set(register, value);
    const ack = await ctx.press('mode', 'boost');
    assert.equal(ack.success, false, `${register}=${value}`);
    assert.match(String(ack.error), /arrêtée ou en veille/);
  }
  ctx.unit.regs.set(1, 1);
  ctx.unit.regs.set(5, 2);
  ctx.unit.regs.set(900, 4 | 2);
  const stopping = await ctx.press('mode', 'boost');
  assert.match(String(stopping.error), /en train de s’arrêter/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a fault (F alarm) refuses the mode and the start', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(900, 4 | 2048);
  assert.match(String((await ctx.press('mode', 'boost')).error), /défaut/);
  ctx.unit.regs.set(1, 0);
  assert.match(String((await ctx.press('start')).error), /défaut/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('an unreadable state refuses the command (never decided on memory)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(5, 99);
  const ack = await ctx.press('mode', 'boost');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /relu/);
  ctx.unit.regs.set(5, 2);
  ctx.unit.exceptions.add('3:900');
  assert.equal((await ctx.press('mode', 'boost')).success, false);
  ctx.unit.exceptions.clear();
  ctx.unit.exceptions.add('3:1000');
  const noId = await ctx.press('start');
  assert.match(String(noId.error), /relu/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('buttons only take 1; read-only features refuse', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  for (const bad of [0, true, 'on', null, 2]) {
    assert.equal((await ctx.press('start', bad, 100)).success, false, String(bad));
    assert.equal((await ctx.press('stop', bad, 100)).success, false, String(bad));
  }
  assert.equal((await ctx.press('power', 0, 100)).success, false);
  assert.equal((await ctx.press('current-mode', 'off', 100)).success, false);
  assert.equal((await ctx.press('temperature-outdoor', 1, 100)).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the start: register 1 = 1, confirmed; a write not applied is "not applied yet"', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(1, 0);
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('start');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /pas encore appliquée/);
  assert.deepEqual(ctx.unit.writes(), [START]);
  ctx.unit.ignoreWrites = false;
  const again = await ctx.press('start');
  assert.equal(again.success, true, String(again.error));
  assert.equal(ctx.state('power').state, 1);
});

test('a write the unit refuses (exception 2): "refused", no guard; device failure: unconfirmed', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.exceptions.add('6:5');
  const ack = await ctx.press('mode', 'boost');
  assert.match(String(ack.error), /a refusé la commande/);
  assert.equal(ctx.app.guards.size, 0);
  ctx.unit.exceptionCode = 4;
  const busy = await ctx.press('mode', 'boost');
  assert.match(String(busy.error), /envoyée, sans confirmation/);
});

test('a wrong echo is never a confirmation', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.badEcho = true;
  const ack = await ctx.press('mode', 'away');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
});

test('the option turned off during the fresh read: refused, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:900'] = 600;
  const ack = ctx.fire('mode', 'boost');
  await ctx.advance(300);
  await ctx.gladys.fake.configUpdated({ ...ALLOW, allow_commands: false });
  await ctx.advance(3000, 50);
  assert.equal((await ack).success, false);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a slow unit: refused unsent within the deadline', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:1'] = 1500;
  const ack = await ctx.press('mode', 'boost');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('the stop: never behind the option, confirmed, then kept in /data', async (t) => {
  const ctx = await setup(t);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [STOP]);
  assert.equal(ctx.state('power').state, 0);
  assert.equal(ctx.store.data.stopGuard.pending, false);
  assert.equal(ctx.store.data.stopGuard.seenOff, true);
  assert.equal(ctx.store.data.stopGuard.host, HOST);
  await ctx.advance(MINUTE + 500, 100);
  assert.match(ctx.status().message.fr, /arrêt envoyé depuis Gladys est gardé/);
});

test('the stop works on a fault, while stopping, with another controller, /data broken', async (t) => {
  const ctx = await setup(t);
  ctx.unit.regs.set(900, 2 | 2048);
  ctx.unit.regs.set(1000, C8_FIRMWARE >>> 16);
  ctx.unit.regs.set(1001, C8_FIRMWARE & 0xffff);
  ctx.store.failSave = true;
  ctx.store.failLoad = true;
  await ctx.advance(MINUTE + 500, 100);
  assert.match(ctx.status().message.fr, /type de régulation a changé/);
  assert.equal((await ctx.press('stop')).success, true);
  assert.deepEqual(ctx.unit.writes(), [STOP]);
});

test('the stop takes the line from a stuck poll (dropped, nothing of it published)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.silent.add('3:900');
  ctx.unit.regs.set(902, 300);
  ctx.unit.regs.set(904, 90);
  const before = ctx.gladys.fake.states.length;
  await ctx.advance(MINUTE + 300, 50);
  assert.ok(ctx.app.active?.kind === 'read', 'a poll is stuck');
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [STOP]);
  const dropped = ctx.gladys.fake.states
    .slice(before)
    .filter((s) => s.device_feature_external_id === feature('temperature-supply'));
  assert.deepEqual(dropped, [], 'the dropped poll published nothing');
  assert.equal(ctx.unit.maxOpen, 1, 'never two connections at once');
  assert.ok(!ctx.logs.some((l) => /next try/.test(l)), 'the dropped poll is no failure');
});

test('the stop cancels a mode not written yet; nothing sent before it leaves after it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:900'] = 600;
  const command = ctx.fire('mode', 'boost');
  await ctx.advance(200);
  const stop = ctx.fire('stop');
  await ctx.advance(5000, 50);
  const [a, b] = await Promise.all([command, stop]);
  assert.equal(a.success, false);
  assert.match(String(a.error), /arrêtée entre-temps/);
  assert.equal(b.success, true, String(b.error));
  assert.deepEqual(ctx.unit.writes(), [STOP]);
  assert.equal(ctx.unit.maxOpen, 1);
  await ctx.advance(30 * SECOND, 100);
  assert.deepEqual(ctx.unit.writes(), [STOP], 'the mode never leaves later');
});

test('the stop goes before the first read after a restart, and says when not sent', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0, 'no read before the interval');
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.down = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /non envoyée|pas encore envoyé/);
});

test('a stop that may not have landed is sent again at start, from /data, before the configuration', async (t) => {
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    target: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID },
    stopGuard: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID, pending: true },
  });
  const getConfig = flakyConfig(Infinity);
  const ctx = await setup(t, { store, boot: true, create: false, getConfig });
  assert.deepEqual(ctx.unit.writes(), [STOP]);
  assert.equal(ctx.unit.log[0].fc, 6, 'the stop is the first request, before any read');
  assert.ok(getConfig.calls() >= 2);
  assert.equal(store.data.stopGuard.pending, false, 'confirmed: no longer pending');
  assert.equal(store.data.stopGuard.seenOff, true);
});

test('the stop works while getConfig() fails: sent to the address kept in /data', async (t) => {
  const store = memoryStore({ target: { unit: UNIT, host: HOST, port: 502, unitId: UNIT_ID } });
  const ctx = await setup(t, {
    store,
    boot: true,
    create: false,
    getConfig: flakyConfig(Infinity),
  });
  assert.match(ctx.status().message.fr, /configuration n’a pas pu être lue/);
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [STOP]);
  assert.equal(ctx.unit.hosts.at(-1), HOST);
});

test('getConfig() failing in connected is retried, spaced, without end, then the unit is read', async (t) => {
  const ctx = await setup(t, { create: false, getConfig: flakyConfig(3) });
  assert.equal(ctx.unit.reads(), 0);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /next try in 5 s/);
  await ctx.advance(5 * SECOND, 100);
  assert.match(ctx.status().message.en, /next try in 15 s/);
  assert.equal(ctx.unit.reads(), 0);
  await ctx.advance(15 * SECOND, 100);
  await ctx.advance(32 * SECOND, 100);
  assert.ok(ctx.unit.reads() > 0, 'read once the configuration is read');
  assert.equal(ctx.status().connected, true, JSON.stringify(ctx.status()) + ctx.logs.join('\n'));
});

test('a reconnection whose getConfig() fails once keeps reading after the retry', async (t) => {
  const ctx = await setup(t);
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let fail = true;
  ctx.gladys.getConfig = async () => {
    if (fail) {
      fail = false;
      throw new Error('timeout');
    }
    return original();
  };
  await ctx.app.connectedWith(() => ctx.gladys.getConfig());
  assert.match(ctx.status().message.en, /configuration could not be read/);
  await ctx.advance(5 * SECOND + 500, 100);
  assert.equal(ctx.status().connected, true);
  const reads = ctx.unit.reads();
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.unit.reads() > reads, 'still polling');
});

test('the kept stop: sent again while not seen off, three times at most, never lifted by the time', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  await ctx.advance(10 * MINUTE, 200);
  assert.equal(
    ctx.unit.writes().filter((w) => w.value === 0).length,
    4,
    'the stop and three resends',
  );
  assert.match(ctx.status().message.fr, /ATTENTION/);
  await ctx.advance(3 * HOUR, 5000);
  assert.ok(ctx.app.stopGuard, 'never lifted by the time');
  assert.ok(ctx.store.data.stopGuard);
});

test('the kept stop: on twice in a row after seen off = started elsewhere, lifted; once = kept', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  ctx.unit.regs.set(1, 1);
  ctx.unit.regs.set(5, 2);
  await ctx.advance(MINUTE + 500, 100);
  assert.ok(ctx.app.stopGuard, 'one read on: still kept');
  ctx.unit.regs.set(1, 0);
  await ctx.advance(MINUTE, 100);
  ctx.unit.regs.set(1, 1);
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.app.stopGuard, 'on, off, on: still kept');
  await ctx.advance(MINUTE, 100);
  assert.equal(ctx.app.stopGuard, undefined, 'on twice in a row: lifted');
  assert.equal(ctx.store.data.stopGuard, null);
  assert.deepEqual(ctx.unit.writes(), [STOP], 'no resend after it was seen off');
  assert.equal(
    (await ctx.press('mode', 'boost')).success,
    true,
    'the mode follows the option again',
  );
});

test('the kept stop refuses the mode; "Start the unit" lifts it (saved before its byte)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  assert.equal((await ctx.press('stop')).success, true);
  const refused = await ctx.press('mode', 'boost');
  assert.match(String(refused.error), /arrêt envoyé depuis Gladys est gardé/);
  ctx.store.failSave = true;
  const blocked = await ctx.press('start');
  assert.equal(blocked.success, false);
  assert.match(String(blocked.error), /\/data/);
  assert.deepEqual(ctx.unit.writes(), [STOP], '/data not written: nothing sent');
  assert.ok(ctx.app.stopGuard);
  ctx.store.failSave = false;
  const ack = await ctx.press('start');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [STOP, START]);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stopGuard, null);
  await ctx.advance(3 * MINUTE, 200);
  assert.deepEqual(ctx.unit.writes(), [STOP, START], 'never stopped again by the reads');
});

test('a stop after a start not confirmed is sticky: resent even after seen off', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(1, 0);
  ctx.unit.ignoreWrites = true;
  await ctx.press('start');
  ctx.unit.ignoreWrites = false;
  assert.equal((await ctx.press('stop')).success, true);
  assert.equal(ctx.app.stopGuard.sticky, true);
  // The late start lands after the stop.
  ctx.unit.regs.set(1, 1);
  await ctx.advance(30 * SECOND, 100);
  const stops = ctx.unit.writes().filter((w) => w.register === 1 && w.value === 0);
  assert.equal(stops.length, 2, 'stopped again');
  assert.equal(ctx.unit.regs.get(1), 0);
});

test('never read sooner than the interval: button, scan, reconnection, same config', async (t) => {
  const ctx = await setup(t);
  const reads = ctx.unit.reads();
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /Prochaine lecture/);
  await ctx.gladys.fake.scanRequest();
  await ctx.app.connected(CFG);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(1000);
  assert.equal(ctx.unit.reads(), reads);
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.unit.reads() > reads, 'read again after the interval');
});

test('a restart waits for the interval after the last read kept in /data', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 30 * SECOND });
  const ctx = await setup(t, { store, create: false });
  assert.equal(ctx.unit.reads(), 0);
  await ctx.advance(MINUTE + 31 * SECOND, 100);
  assert.ok(ctx.unit.reads() > 0);
  assert.ok(store.data.lastAttemptAt > NOW, 'the time of the read kept before it');
});

test('an unreachable unit: status says so, retried with a backoff, device unreachable', async (t) => {
  const ctx = await setup(t);
  ctx.unit.down = true;
  await ctx.advance(MINUTE + 100, 100);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.fr, /Modbus TCP est activé/);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  const tries = ctx.unit.connections;
  await ctx.advance(30 * SECOND, 500);
  assert.equal(ctx.unit.connections, tries, 'never sooner than the interval'); // The stop does not wait for the backoff.
  ctx.unit.down = false;
  const ack = await ctx.press('stop');
  assert.equal(ack.success, true, String(ack.error));
  assert.deepEqual(ctx.unit.writes(), [STOP]);
});

test('a secondary block refused or silent never blocks the values (skipped for an hour)', async (t) => {
  const ctx = await setup(t);
  ctx.unit.exceptions.add('3:600');
  ctx.unit.regs.set(902, 200);
  await ctx.advance(MINUTE, 100);
  assert.ok(ctx.logs.some((l) => /block alarms refused/.test(l)));
  assert.equal(ctx.state('temperature-supply').state, 20);
  assert.equal(ctx.status().connected, true);
  const before = ctx.unit.log.filter((r) => r.register === 600).length;
  await ctx.advance(2 * MINUTE, 100);
  assert.equal(ctx.unit.log.filter((r) => r.register === 600).length, before, 'skipped');
  // The firmware block never answers: the values before it are still published.
  ctx.unit.silent.add('3:1000');
  for (let i = 0; i < 4; i += 1) {
    ctx.unit.regs.set(902, 210 + i);
    await ctx.advance(MINUTE + 3 * SECOND, 100);
    assert.equal(ctx.state('temperature-supply').state, 21 + i / 10, ctx.logs.slice(-8).join('\n'));
  }
  assert.ok(
    ctx.logs.some((l) => /firmware never answers/.test(l)),
    ctx.logs.join('\n'),
  );
  assert.equal(ctx.status().connected, true);
});

test('frames in chunks are read; an answer to another transaction ends the read', async (t) => {
  const unit = fakeKomfovent();
  unit.split = true;
  const ctx = await setup(t, { unit });
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  unit.split = false;
  unit.wrongTransaction = true;
  unit.regs.set(902, 200);
  await ctx.advance(MINUTE + 4 * SECOND, 50);
  assert.equal(ctx.state('temperature-supply').state, 18.5);
  assert.equal(ctx.status().connected, false);
});

test('another controller type: commands refused, the test button accepts it', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.regs.set(1000, C8_FIRMWARE >>> 16);
  ctx.unit.regs.set(1001, C8_FIRMWARE & 0xffff);
  await ctx.advance(MINUTE + 500, 100);
  assert.match(ctx.status().message.fr, /C6 → C8/);
  assert.match(String((await ctx.press('mode', 'boost')).error), /régulation/);
  assert.deepEqual(ctx.unit.writes(), []);
  const answer = await ctx.gladys.fake.action('test_connection');
  assert.match(JSON.stringify(answer), /C8/);
  assert.equal(ctx.store.data.identity.controller, 'C8');
  assert.equal((await ctx.press('mode', 'boost')).success, true);
});

test('/data unreadable: no identity learnt, nothing written over it, commands refused', async (t) => {
  const store = memoryStore({ identity: { unit: UNIT, controller: 'C8' } });
  store.failLoad = true;
  const ctx = await setup(t, { store, config: ALLOW });
  assert.equal(ctx.state('temperature-supply').state, 18.5, 'still read');
  assert.equal(store.saves, 0, 'never written over');
  assert.match(ctx.status().message.fr, /\/data illisible/);
  assert.match(String((await ctx.press('mode', 'boost')).error), /\/data/);
  assert.deepEqual(ctx.unit.writes(), []);
  assert.deepEqual(store.data.identity, { unit: UNIT, controller: 'C8' });
  assert.equal(ctx.app.memory.identity, null, 'nothing learnt over it');
  assert.equal(ctx.gladys.fake.discoveredDevices.at(-1).model, 'Komfovent');
});

test('a new address keeps the device; a stop of the old one is not shown for the new one', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('stop')).success, true);
  const updating = ctx.gladys.fake.configUpdated({ host: '192.168.1.81' });
  await ctx.advance(2000, 50);
  await updating;
  assert.doesNotMatch(ctx.status().message.fr, /gardé/);
  assert.equal(ctx.unit.hosts.at(-1), '192.168.1.81');
  assert.equal(ctx.gladys.fake.discoveredDevices.at(-1).external_id, DEVICE);
});

test('the clean shutdown keeps the state in /data', async (t) => {
  const ctx = await setup(t);
  assert.equal((await ctx.press('stop')).success, true);
  const saves = ctx.store.saves;
  await ctx.app.shutdown();
  assert.ok(ctx.store.saves > saves);
  assert.equal(ctx.store.data.stopGuard.unit, UNIT);
});

test('a stop whose /data write is slow still cancels a mode about to be written', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: ALLOW, store });
  const save = store.save.bind(store);
  store.save = (data) => new Promise((resolve) => setTimeout(() => resolve(save(data)), 120));
  ctx.unit.delays['3:1000'] = 60;
  const command = ctx.fire('mode', 'boost');
  await ctx.advance(60, 5);
  const stop = ctx.fire('stop');
  await ctx.advance(5000, 20);
  const [a, b] = await Promise.all([command, stop]);
  assert.equal(a.success, false);
  assert.match(String(a.error), /arrêtée entre-temps/);
  assert.equal(b.success, true, String(b.error));
  assert.deepEqual(ctx.unit.writes(), [STOP]);
});

test('a kept stop appearing during the fresh read refuses the mode (checked again after the read)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.delays['3:900'] = 200;
  const command = ctx.fire('mode', 'boost');
  await ctx.advance(100, 10);
  ctx.app.stopGuard = {
    unit: UNIT,
    host: HOST,
    port: 502,
    unitId: UNIT_ID,
    sentAt: ctx.app.mono(),
    pending: false,
    seenOff: true,
    onReads: 0,
    reasserts: 0,
    sticky: false,
  };
  await ctx.advance(5000, 50);
  const ack = await command;
  assert.match(String(ack.error), /arrêt envoyé depuis Gladys est gardé/);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('"Start the unit" on a unit already on lifts the kept stop, nothing written', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.unit.ignoreWrites = true;
  await ctx.press('stop');
  ctx.unit.ignoreWrites = false;
  assert.ok(ctx.app.stopGuard);
  const writes = ctx.unit.writes().length;
  const ack = await ctx.press('start');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stopGuard, null);
  assert.equal(ctx.unit.writes().length, writes, 'already on: nothing written');
});

test('a start newer than the kept stop lifts it at the next read (never resent over it)', async (t) => {
  const ctx = await setup(t, { config: ALLOW });
  ctx.app.stopGuard = {
    unit: UNIT,
    host: HOST,
    port: 502,
    unitId: UNIT_ID,
    sentAt: ctx.app.mono(),
    pending: true,
    seenOff: false,
    onReads: 0,
    reasserts: 0,
    sticky: false,
  };
  ctx.app.lastStartAt = ctx.app.mono();
  await ctx.advance(MINUTE + 2 * SECOND, 100);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.deepEqual(ctx.unit.writes(), []);
});

test('a stop not confirmed, then the unit read off, then on twice: lifted, never resent', async (t) => {
  const ctx = await setup(t);
  ctx.unit.ignoreWrites = true;
  const ack = ctx.fire('stop');
  await ctx.advance(4500, 50);
  assert.match(String((await ack).error), /sans confirmation/);
  ctx.unit.ignoreWrites = false;
  ctx.unit.regs.set(1, 0); // stopped on its panel, or the stop landed late
  await ctx.advance(6 * SECOND, 100);
  assert.equal(ctx.store.data.stopGuard.seenOff, true);
  assert.equal(ctx.store.data.stopGuard.pending, false);
  ctx.unit.regs.set(1, 1);
  await ctx.advance(2 * MINUTE, 100);
  assert.equal(ctx.app.stopGuard, undefined, 'started elsewhere: lifted');
  assert.deepEqual(ctx.unit.writes(), [STOP], 'never resent once seen off');
});

test('the period is start to start, even with a slow unit', async (t) => {
  const ctx = await setup(t);
  ctx.unit.delay = 400;
  const starts = [];
  const log = ctx.unit.log;
  const push = log.push.bind(log);
  log.push = (entry) => {
    if (entry.register === 1 && entry.fc === 3) starts.push(Date.now());
    return push(entry);
  };
  await ctx.advance(4 * MINUTE + 5 * SECOND, 100);
  const gaps = starts.slice(1).map((v, i) => v - starts[i]);
  assert.ok(gaps.length >= 3, `${gaps.length} gaps`);
  for (const gap of gaps) {
    assert.ok(gap >= MINUTE && gap <= MINUTE + 200, `gap ${gap} ms`);
  }
});
