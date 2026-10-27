// -----------------------------------------------------------------------------
// The Modbus PDUs of the Komfovent C6 / C6M / C8 controllers (pure): the read
// requests of the blocks, what their answers mean, and the write requests.
// Register numbers and meanings from Komfovent's Modbus manuals (C6 / C6M
// 24-10, C8 24-10) as hass-komfovent reads them. Every decoder returns
// undefined when the answer has not the exact size asked or the value is not
// plausible: an unknown value is never a value, and a text is never a 0.
// -----------------------------------------------------------------------------

import {
  AQ_TYPES,
  CONTROLLERS,
  FC,
  LIMITS,
  PANEL1_CONNECTED,
  RANGES,
  READ_MODES,
  STATUS_BITS,
} from '../constants.js';

const round1 = (value) => Math.round(value * 10) / 10;

/** The read request of a block (function 3 only). */
export function readRequest({ fc, address, count }) {
  const pdu = Buffer.alloc(5);
  pdu[0] = fc;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words (16-bit registers) of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead({ fc, count }, pdu) {
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== fc || fc !== FC.READ_HOLDING) {
    return undefined;
  }
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(pdu.readUInt16BE(2 + i * 2));
  }
  return words;
}

/** Signed 16-bit (temperatures below zero, panel humidity "-100"). */
const int16 = (word) => (word >= 0x8000 ? word - 0x10000 : word);

const within = (value, [min, max]) =>
  Number.isFinite(value) && value >= min && value <= max ? value : undefined;

/** Tenths of a degree, signed; undefined when out of range (sensor absent, 30000, -32768). */
const temperature = (word) =>
  Number.isInteger(word) ? within(round1(int16(word) / 10), RANGES.temperature) : undefined;

/** Tenths of a percent (fan levels). */
const tenthPercent = (word) =>
  Number.isInteger(word) ? within(round1(word / 10), RANGES.percent) : undefined;

/** A register holding 0 or 1 (anything else is unknown). */
const flag = (word) => (word === 0 ? false : word === 1 ? true : undefined);

/** "F9", "W1": the manual's notation of an alarm code (MSb set: a warning). */
export function alarmCode(word) {
  if (!Number.isInteger(word) || word < 1 || word > 0xff || (word & 0x7f) === 0) return undefined;
  return `${word & 0x80 ? 'W' : 'F'}${word & 0x7f}`;
}

/**
 * The controller of registers 1000-1001 (hass-komfovent: type in the top
 * four bits, then 4, 4, 8 and 12 bits of version): `{ controller, firmware }`,
 * undefined when the type is not a known controller (0 or not answered).
 */
export function decodeFirmware(high, low) {
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  const value = high * 0x10000 + low;
  const controller = CONTROLLERS[(value >>> 28) & 0xf];
  if (!controller || value === 0) return undefined;
  const parts = [(value >>> 24) & 0xf, (value >>> 20) & 0xf, (value >>> 12) & 0xff, value & 0xfff];
  return { controller, firmware: `${controller} ${parts.join('.')}` };
}

/** Register `register` (manual number) of a block of words starting at `start`. */
const at = (words, start, register) => words[register - start];

/**
 * The values a block gives (only those plausible). The words are those of
 * `parseRead`.
 */
export function decodeBlock(block, data) {
  if (!Array.isArray(data) || data.length !== block.count) return {};
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  const word = (register) => at(data, block.register, register);
  switch (block.key) {
    case 'control':
      put('power', flag(word(1)));
      put('eco', flag(word(3)));
      put('auto', flag(word(4)));
      put('mode', READ_MODES[word(5)]);
      break;
    case 'monitor': {
      const status = word(900);
      if (Number.isInteger(status) && status <= 0x1fff) {
        values.status = status;
        put('fanRunning', (status & STATUS_BITS.fan) !== 0);
        put('fault', (status & STATUS_BITS.alarmF) !== 0);
        put('warning', (status & STATUS_BITS.alarmW) !== 0);
      }
      put('supply', temperature(word(902)));
      put('extract', temperature(word(903)));
      put('outdoor', temperature(word(904)));
      put('fanSupply', tenthPercent(word(910)));
      put('fanExtract', tenthPercent(word(911)));
      put('filter', within(word(917), RANGES.percent));
      // Without air flow (fans stopped, or status unknown) the efficiency and
      // the extract air sensors mean nothing: unknown, never published
      // (hass-komfovent's choice, REGISTERS_UNKNOWN_WITHOUT_FLOW).
      const flowing = values.fanRunning === true;
      if (flowing) put('efficiency', within(word(924), RANGES.percent));
      // The panel values only when panel 1 is connected (C8: -32768 / -100 otherwise).
      if (PANEL1_CONNECTED.has(word(954))) {
        put('panelTemperature', temperature(word(946)));
        const rh = word(947);
        put('panelHumidity', Number.isInteger(rh) ? within(int16(rh), RANGES.percent) : undefined);
      }
      if (flowing) {
        put('aq1', Number.isInteger(word(952)) ? word(952) : undefined);
        put('aq2', Number.isInteger(word(953)) ? word(953) : undefined);
      }
      break;
    }
    case 'alarms': {
      const count = within(word(600), [0, LIMITS.alarmCodes]);
      put('alarmCount', count);
      if (count !== undefined) {
        const codes = [];
        for (let i = 0; i < count; i += 1) {
          const code = alarmCode(word(601 + i));
          if (code === undefined) {
            // A code that does not read: the whole list is unknown this time.
            codes.length = 0;
            break;
          }
          codes.push(code);
        }
        if (codes.length === count) {
          values.alarmCodes = count === 0 ? 'none' : codes.join(', ');
        }
      }
      break;
    }
    case 'aq':
      put('aq1Type', AQ_TYPES[word(213)]);
      put('aq2Type', AQ_TYPES[word(214)]);
      break;
    case 'firmware': {
      const decoded = decodeFirmware(word(1000), word(1001));
      if (decoded) {
        values.controller = decoded.controller;
        values.firmware = decoded.firmware;
      }
      break;
    }
    default:
      break;
  }
  return values;
}

/** The write request of a command: a single register (function 6, a value 0-65535). */
export function writeRequest({ fc, address }, value) {
  if (fc !== FC.WRITE_REGISTER) throw new RangeError('Not a write function');
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError('A register value is 0-65535');
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = fc;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(value, 3);
  return pdu;
}

/** A write is answered by the exact echo of its request. */
export const isEcho = (request, answer) => Buffer.isBuffer(answer) && request.equals(answer);
