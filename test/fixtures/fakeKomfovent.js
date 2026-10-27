// -----------------------------------------------------------------------------
// A fake Komfovent C6 controller behind the injected `connect` (no network):
// Modbus TCP framing (MBAP), the holding registers the integration reads,
// writes applied, answers after a delay (mocked timers). It counts the
// connections open at once (the integration must never open a second one).
// `frameAnswer()` is the same logic for a real TCP server (gladys-testkit).
// Values made up, never from a real unit.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.80';
export const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
/** hass-komfovent's default unit id. */
export const UNIT_ID = 254;

/** The firmware word of a C6 1.3.17.20 (type 0 in the top four bits). */
export const C6_FIRMWARE = (0 << 28) | (1 << 24) | (3 << 20) | (17 << 12) | 20;
export const C8_FIRMWARE = (2 << 28) | (1 << 24) | (0 << 20) | (5 << 12) | 3;

const FAN = 1 << 2;

/** A unit on, in Normal, fans running, no alarm. Keys: register numbers of the manual. */
export function defaultMap() {
  const regs = new Map();
  for (let r = 1; r <= 34; r += 1) regs.set(r, 0);
  for (let r = 200; r <= 214; r += 1) regs.set(r, 0);
  for (let r = 600; r <= 610; r += 1) regs.set(r, 0);
  for (let r = 900; r <= 955; r += 1) regs.set(r, 0);
  regs.set(1, 1); // on
  regs.set(5, 2); // normal
  regs.set(900, FAN);
  regs.set(902, 185); // supply 18.5 °C
  regs.set(903, 214); // extract 21.4 °C
  regs.set(904, 0x10000 - 52); // outdoor -5.2 °C
  regs.set(910, 455); // supply fan 45.5 %
  regs.set(911, 470); // extract fan 47 %
  regs.set(917, 12); // filter clogging 12 %
  regs.set(924, 83); // efficiency 83 %
  regs.set(946, 212); // panel 21.2 °C
  regs.set(947, 41); // panel 41 %
  regs.set(954, 1); // panel 1 connected
  regs.set(213, 1); // sensor 1: CO2
  regs.set(214, 3); // sensor 2: humidity
  regs.set(952, 640); // 640 ppm
  regs.set(953, 55); // 55 %
  regs.set(1000, (C6_FIRMWARE >>> 16) & 0xffff);
  regs.set(1001, C6_FIRMWARE & 0xffff);
  return regs;
}

/** What a write does on the fake unit (register number, value). */
export function applyWrite(regs, register, value) {
  regs.set(register, value);
  if (register === 1) {
    if (value === 0) {
      regs.set(5, 10); // off
      regs.set(900, regs.get(900) & ~FAN);
    } else {
      regs.set(5, 2);
      regs.set(900, regs.get(900) | FAN);
    }
  }
}

/**
 * The answer PDU to a request PDU (function 3 or 6, else illegal function),
 * or undefined when the request is not understood.
 */
export function pduAnswer(regs, pdu, { ignoreWrites = false } = {}) {
  const fc = pdu[0];
  const address = pdu.readUInt16BE(1);
  const arg = pdu.readUInt16BE(3);
  if (fc === 3) {
    const answer = Buffer.alloc(2 + arg * 2);
    answer[0] = fc;
    answer[1] = arg * 2;
    for (let i = 0; i < arg; i += 1) {
      answer.writeUInt16BE(regs.get(address + 1 + i) ?? 0, 2 + i * 2);
    }
    return answer;
  }
  if (fc === 6) {
    if (!ignoreWrites) applyWrite(regs, address + 1, arg);
    return Buffer.from(pdu);
  }
  return Buffer.from([fc | 0x80, 1]);
}

/** One MBAP frame in, its answer frame out (for a real TCP server). */
export function frameAnswer(regs, frame) {
  const pdu = frame.subarray(7);
  const answer = pduAnswer(regs, pdu);
  const out = Buffer.alloc(7 + answer.length);
  frame.copy(out, 0, 0, 4);
  out.writeUInt16BE(answer.length + 1, 4);
  out[6] = frame[6];
  answer.copy(out, 7);
  return out;
}

class FakeSocket extends EventEmitter {
  constructor(unit) {
    super();
    this.unit = unit;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.unit.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.unit.open.has(this)) {
      this.unit.open.delete(this);
    }
    setImmediate(() => this.emit('close'));
  }

  setNoDelay() {}
}

export function fakeKomfovent({ map = defaultMap() } = {}) {
  const unit = {
    regs: map,
    open: new Set(),
    /** The most connections open at once (must stay 1). */
    maxOpen: 0,
    /** Every request received: { fc, register, count | value, uid, host, port }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** Registers ("fc:register" keys or fc) that never answer, answer an exception, or delays. */
    silent: new Set(),
    exceptions: new Set(),
    exceptionCode: 2,
    delays: {},
    /** Writes acknowledged but not applied (an unconfirmed command). */
    ignoreWrites: false,
    /** Writes applied even after their connection closed. */
    applyClosedWrites: false,
    /** The next connections accepted then closed at once. */
    dropConnections: 0,
    /** Answers split in two chunks, or with a wrong transaction id, or a wrong echo. */
    split: false,
    wrongTransaction: false,
    badEcho: false,
    /** Hosts connected to. */
    hosts: [],
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const register = pdu.readUInt16BE(1) + 1;
      const arg = pdu.readUInt16BE(3);
      const write = fc === 6;
      unit.log.push(
        write
          ? { fc, register, value: arg, uid, host: socket.host }
          : { fc, register, count: arg, uid, host: socket.host },
      );
      const key = `${fc}:${register}`;
      if (unit.silent.has(key) || unit.silent.has(fc)) return;
      setTimeout(() => {
        if (socket.destroyed) {
          // A write already in the unit is applied even when its connection is gone.
          if (write && unit.applyClosedWrites && !unit.ignoreWrites) {
            applyWrite(unit.regs, register, arg);
          }
          return;
        }
        let answer;
        if (unit.exceptions.has(key) || unit.exceptions.has(fc)) {
          answer = Buffer.from([fc | 0x80, unit.exceptionCode]);
        } else {
          answer = pduAnswer(unit.regs, pdu, { ignoreWrites: unit.ignoreWrites });
          if (write && unit.badEcho) answer[4] ^= 1;
        }
        const out = Buffer.alloc(7 + answer.length);
        out.writeUInt16BE(unit.wrongTransaction ? (tid + 1) & 0xffff : tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(answer.length + 1, 4);
        out[6] = uid;
        answer.copy(out, 7);
        if (unit.split) {
          socket.emit('data', out.subarray(0, 3));
          socket.emit('data', out.subarray(3));
        } else {
          socket.emit('data', out);
        }
      }, unit.delays[key] ?? unit.delay);
    },
    connect(host) {
      const socket = new FakeSocket(unit);
      socket.host = host;
      unit.hosts.push(host);
      unit.connections += 1;
      setTimeout(() => {
        if (socket.destroyed) return;
        if (unit.down) {
          unit.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        if (unit.dropConnections > 0) {
          unit.dropConnections -= 1;
          socket.emit('connect');
          setImmediate(() => !socket.destroyed && socket.emit('close'));
          return;
        }
        unit.open.add(socket);
        unit.maxOpen = Math.max(unit.maxOpen, unit.open.size);
        socket.emit('connect');
      }, unit.connectDelay);
      return socket;
    },
    writes: () =>
      unit.log
        .filter((r) => r.fc === 6)
        .map(({ fc, register, value }) => ({ fc, register, value })),
    reads: () => unit.log.filter((r) => r.fc !== 6).length,
  };
  unit.connectFn = (host) => unit.connect(host);
  return unit;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
