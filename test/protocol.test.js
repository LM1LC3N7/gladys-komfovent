// -----------------------------------------------------------------------------
// The pure layers: Modbus PDUs and their decoding, the MBAP session against a
// fake socket (bounded frames, hostile answers), and the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { BLOCKS, BLOCK_OF, FC } from '../src/constants.js';
import { ERROR_KINDS, ModbusSession } from '../src/modbus/client.js';
import {
  alarmCode,
  decodeBlock,
  decodeFirmware,
  isEcho,
  parseRead,
  readRequest,
  writeRequest,
} from '../src/modbus/protocol.js';

/** The words of a block starting at register `start`, with some registers set. */
const words = (start, count, set = {}) => {
  const out = new Array(count).fill(0);
  for (const [register, value] of Object.entries(set)) out[Number(register) - start] = value;
  return out;
};

test('read requests: function 3, protocol address = register - 1, the ranges of hass-komfovent', () => {
  assert.deepEqual([...readRequest(BLOCK_OF.control)], [3, 0, 0, 0, 34]);
  assert.deepEqual([...readRequest(BLOCK_OF.monitor)], [3, 0x03, 0x83, 0, 56]);
  assert.deepEqual([...readRequest(BLOCK_OF.alarms)], [3, 0x02, 0x57, 0, 11]);
  assert.deepEqual([...readRequest(BLOCK_OF.aq)], [3, 0, 199, 0, 15]);
  assert.deepEqual([...readRequest(BLOCK_OF.firmware)], [3, 0x03, 0xe7, 0, 2]);
  assert.ok(BLOCKS.every((b) => b.fc === FC.READ_HOLDING && b.count * 2 + 9 <= 260));
});

test('parseRead: only the exact size asked', () => {
  const block = { fc: FC.READ_HOLDING, count: 2 };
  assert.deepEqual(parseRead(block, Buffer.from([3, 4, 0, 1, 0xff, 0xfe])), [1, 0xfffe]);
  assert.equal(parseRead(block, Buffer.from([3, 4, 0, 1, 0xff])), undefined);
  assert.equal(parseRead(block, Buffer.from([3, 2, 0, 1])), undefined);
  assert.equal(parseRead(block, Buffer.from([4, 4, 0, 1, 0, 2])), undefined);
  assert.equal(parseRead(block, Buffer.from([3, 6, 0, 1, 0, 2, 0, 3])), undefined);
});

test('decodeBlock control: on/off, ECO, AUTO, mode keys; unknown values left out', () => {
  const c = decodeBlock(BLOCK_OF.control, words(1, 34, { 1: 1, 3: 0, 4: 1, 5: 4 }));
  assert.deepEqual(c, { power: true, eco: false, auto: true, mode: 'boost' });
  assert.equal(decodeBlock(BLOCK_OF.control, words(1, 34, { 5: 10 })).mode, 'off');
  assert.equal(decodeBlock(BLOCK_OF.control, words(1, 34, { 5: 0 })).mode, 'standby');
  const odd = decodeBlock(BLOCK_OF.control, words(1, 34, { 1: 2, 5: 11 }));
  assert.equal(odd.power, undefined, '2 is not on/off');
  assert.equal(odd.mode, undefined, '11 is no mode');
  assert.deepEqual(decodeBlock(BLOCK_OF.control, words(1, 10)), {}, 'wrong count: nothing');
});

test('decodeBlock monitor: signed tenths, sentinels, fans, flow-dependent values', () => {
  const m = decodeBlock(
    BLOCK_OF.monitor,
    words(900, 56, {
      900: 4 | 2048,
      902: 0x10000 - 125,
      903: 225,
      904: 30000,
      910: 455,
      911: 1001,
      917: 12,
      924: 83,
      946: 0x10000 - 32768,
      947: 0x10000 - 100,
      952: 640,
      953: 55,
      954: 1,
    }),
  );
  assert.equal(m.status, 4 | 2048);
  assert.equal(m.fanRunning, true);
  assert.equal(m.fault, true);
  assert.equal(m.warning, false);
  assert.equal(m.supply, -12.5);
  assert.equal(m.extract, 22.5);
  assert.equal(m.outdoor, undefined, 'C8 30000: sensor not used, never a temperature');
  assert.equal(m.fanSupply, 45.5);
  assert.equal(m.fanExtract, undefined, '100.1 % is no level');
  assert.equal(m.filter, 12);
  assert.equal(m.efficiency, 83);
  assert.equal(m.panelTemperature, undefined, '-32768: panel not connected');
  assert.equal(m.panelHumidity, undefined, '-100: panel not connected');
  assert.equal(m.aq1, 640);
  const stopped = decodeBlock(
    BLOCK_OF.monitor,
    words(900, 56, { 900: 0, 924: 83, 952: 640, 954: 0, 946: 210 }),
  );
  assert.equal(stopped.fanRunning, false);
  assert.equal(stopped.efficiency, undefined, 'no flow: unknown (hass-komfovent)');
  assert.equal(stopped.aq1, undefined, 'no flow: the extract sensors are unknown');
  assert.equal(stopped.panelTemperature, undefined, 'panel 1 not connected');
  const noStatus = decodeBlock(BLOCK_OF.monitor, words(900, 56, { 900: 0xffff, 924: 83 }));
  assert.equal(noStatus.status, undefined);
  assert.equal(noStatus.efficiency, undefined, 'unknown flow: unknown');
});

test('decodeBlock alarms: codes in the manual notation, a text never a 0', () => {
  assert.deepEqual(decodeBlock(BLOCK_OF.alarms, words(600, 11, { 600: 0 })), {
    alarmCount: 0,
    alarmCodes: 'none',
  });
  assert.deepEqual(decodeBlock(BLOCK_OF.alarms, words(600, 11, { 600: 2, 601: 9, 602: 0x81 })), {
    alarmCount: 2,
    alarmCodes: 'F9, W1',
  });
  const unreadable = decodeBlock(BLOCK_OF.alarms, words(600, 11, { 600: 2, 601: 9, 602: 0 }));
  assert.equal(unreadable.alarmCodes, undefined, 'a code missing: the list is unknown');
  assert.equal(decodeBlock(BLOCK_OF.alarms, words(600, 11, { 600: 0x99c6 })).alarmCount, undefined);
  assert.equal(alarmCode(0x80), undefined);
  assert.equal(alarmCode(0x100), undefined);
});

test('decodeBlock firmware and sensor types', () => {
  const c6 = 0x01311014;
  assert.deepEqual(decodeBlock(BLOCK_OF.firmware, [c6 >>> 16, c6 & 0xffff]), {
    controller: 'C6',
    firmware: 'C6 1.3.17.20',
  });
  const c8 = 0x21005003;
  assert.equal(decodeBlock(BLOCK_OF.firmware, [c8 >>> 16, c8 & 0xffff]).controller, 'C8');
  assert.deepEqual(decodeBlock(BLOCK_OF.firmware, [0, 0]), {}, 'nothing read is no controller');
  assert.deepEqual(decodeBlock(BLOCK_OF.firmware, [0xf000, 0]), {}, 'type 15: unknown');
  assert.deepEqual(decodeFirmware(0x1000, 1)?.controller, 'C6M');
  const aq = decodeBlock(BLOCK_OF.aq, words(200, 15, { 213: 1, 214: 3 }));
  assert.deepEqual(aq, { aq1Type: 'co2', aq2Type: 'humidity' });
  assert.deepEqual(decodeBlock(BLOCK_OF.aq, words(200, 15, { 213: 7 })).aq1Type, undefined);
});

test('write requests: function 6 only, strict values; echo', () => {
  const stop = writeRequest({ fc: FC.WRITE_REGISTER, address: 0 }, 0);
  assert.deepEqual([...stop], [6, 0, 0, 0, 0]);
  assert.deepEqual([...writeRequest({ fc: FC.WRITE_REGISTER, address: 4 }, 3)], [6, 0, 4, 0, 3]);
  assert.throws(() => writeRequest({ fc: FC.WRITE_REGISTER, address: 0 }, -1));
  assert.throws(() => writeRequest({ fc: FC.WRITE_REGISTER, address: 0 }, true));
  assert.throws(() => writeRequest({ fc: FC.READ_HOLDING, address: 0 }, 1));
  assert.equal(isEcho(stop, Buffer.from(stop)), true);
  assert.equal(isEcho(stop, Buffer.from([6, 0, 0, 0, 1])), false);
});

class Socket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.destroyed = false;
  }
  write(bytes) {
    this.sent.push(Buffer.from(bytes));
  }
  destroy() {
    this.destroyed = true;
  }
}

/** The MBAP answer to the last request sent, with `pdu`. */
function answer(socket, pdu, { tid, uid } = {}) {
  const request = socket.sent.at(-1);
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid ?? request.readUInt16BE(0), 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out[6] = uid ?? request[6];
  Buffer.from(pdu).copy(out, 7);
  return out;
}

test('session: MBAP framing, unit id, answers in chunks', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { unitId: 3 });
  const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
    timeoutMs: 1000,
  });
  const frame = socket.sent[0];
  assert.equal(frame.readUInt16BE(2), 0);
  assert.equal(frame.readUInt16BE(4), 6);
  assert.equal(frame[6], 3);
  const out = answer(socket, [3, 2, 0, 2]);
  socket.emit('data', out.subarray(0, 4));
  socket.emit('data', out.subarray(4));
  assert.deepEqual([...(await pending)], [3, 2, 0, 2]);
  session.close();
});

test('session: hostile answers end it', async () => {
  const cases = [
    ['another transaction', (s) => answer(s, [3, 2, 0, 2], { tid: 0xbeef })],
    ['another unit id', (s) => answer(s, [3, 2, 0, 2], { uid: 9 })],
    ['another function', (s) => answer(s, [4, 2, 0, 2])],
    ['bytes beyond the frame', (s) => Buffer.concat([answer(s, [3, 2, 0, 2]), Buffer.from([0])])],
    [
      'a length over 260',
      (s) => {
        const b = answer(s, [3, 2, 0, 2]);
        b.writeUInt16BE(300, 4);
        return b;
      },
    ],
  ];
  for (const [name, build] of cases) {
    const socket = new Socket();
    const session = new ModbusSession(socket, { unitId: 1 });
    const pending = session.request(readRequest({ fc: 3, address: 1, count: 1 }), {
      timeoutMs: 1000,
    });
    socket.emit('data', build(socket));
    await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent, name);
    assert.ok(socket.destroyed, name);
  }
  const socket = new Socket();
  const session = new ModbusSession(socket);
  socket.emit('data', Buffer.from([0, 1, 0, 0, 0, 3, 1, 3, 0]));
  assert.ok(socket.destroyed, 'bytes without a request');
  assert.ok(session.dead);
});

test('session: an exception is REFUSED (sent), the session stays', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket);
  const pending = session.request(writeRequest({ fc: 6, address: 1 }, 2), { timeoutMs: 1000 });
  socket.emit('data', answer(socket, [0x86, 2]));
  await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.REFUSED && err.sent);
  assert.equal(session.dead, undefined);
  session.close();
});

test('session: beforeSend and startBy stop a request before any byte', async () => {
  const socket = new Socket();
  const session = new ModbusSession(socket, { now: () => 100 });
  await assert.rejects(
    session.request(Buffer.from([3, 0, 1, 0, 1]), { startBy: 50 }),
    (err) => err.kind === ERROR_KINDS.LATE && !err.sent,
  );
  await assert.rejects(
    session.request(Buffer.from([3, 0, 1, 0, 1]), {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    (err) => err.beforeSend === true,
  );
  assert.equal(socket.sent.length, 0);
  session.close();
});

test('config: addresses, port, unit id (strict), interval', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 502 });
  assert.deepEqual(parseAddress('komfovent.lan:1502'), { host: 'komfovent.lan', port: 1502 });
  for (const bad of [
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    '192.168.1.0',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const ok = normalizeConfig({ host: '192.168.1.80', unit_id: '12' });
  assert.equal(ok.unitId, 12);
  assert.ok(ok.address);
  for (const bad of ['', ' ', '0', '256', 1.5, 'abc', '-1']) {
    const c = normalizeConfig({ host: '192.168.1.80', unit_id: bad });
    assert.equal(c.address, undefined, String(bad));
    assert.equal(c.badUnitId, true, String(bad));
  }
  assert.equal(normalizeConfig({ host: 'x', unit_id: null }).unitId, 254, 'missing: the default');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ host: 'bad\u0007host' }).invalid, 8, 'only its length');
});
