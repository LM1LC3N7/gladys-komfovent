// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the time of the last read of the unit (written at most once a
// minute, BEFORE the read), so a restart never reads the unit sooner than the
// interval; the controller type learnt for the unit (its light identity); a
// kept stop (the address it was sent to, whether it may not have landed yet,
// whether the unit was seen off since, the resends left). No secret (the
// Modbus interface has none), no personal data. The file is readable by the
// container user only (0600), bounded and repaired when read back.
//
// `load()` tells "no file" (null) from "a file that cannot be read" (it
// throws): an unreadable /data is never taken for an empty one (no new
// identity is learnt over it, no kept stop is forgotten by a later write).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { DEFAULT_PORT, TIMINGS, UNIT_ID } from './constants.js';

export const STATE_FILE = '/data/komfovent-state.json';
const MAX_SIZE = 4 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw new Error(`state file unreadable (${err?.code ?? 'error'})`, { cause: err });
      }
      if (text.length > MAX_SIZE) throw new Error('state file too large');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('state file not JSON');
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        if (text.length > MAX_SIZE) throw new Error('state too large');
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failLoad` / `failSave` simulate a broken /data. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failLoad: false,
    failSave: false,
    async load() {
      if (this.failLoad) throw new Error('state file unreadable (EIO)');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failSave) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : undefined;

const HOST = /^[a-z0-9.-]{1,253}$/;

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null (a time in the
 *   future counts as now: never a longer wait than the interval);
 * - `identity`: `{ unit, controller }` learnt for the unit `unit` (address and
 *   Modbus unit id), or null;
 * - `target`: `{ unit, host, port, unitId }`, the unit of the last
 *   configuration read (a stop pressed before the configuration is read
 *   again goes there), or null;
 * - `stopGuard`: `{ unit, host, port, unitId, pending, seenOff, onReads,
 *   reasserts, sticky }`, a kept stop, or null. It holds no date: it is never
 *   lifted by the time, only by a start pressed in Gladys (with the option) or
 *   by the unit read on twice in a row after it was seen off.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const identity = data.identity && typeof data.identity === 'object' ? data.identity : {};
  const guard = data.stopGuard && typeof data.stopGuard === 'object' ? data.stopGuard : {};
  const unit = shortText(identity.unit, 280);
  const controller = shortText(identity.controller, 8);
  const guardTarget = normalizeTarget(guard);
  const count = (value, max) => (Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0);
  return {
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    identity: unit && controller ? { unit, controller } : null,
    target: normalizeTarget(data.target) ?? null,
    stopGuard: guardTarget
      ? {
          ...guardTarget,
          // Anything but a clear false: the stop may not have landed (sent again at start).
          pending: guard.pending !== false,
          seenOff: guard.seenOff === true,
          onReads: count(guard.onReads, 2),
          reasserts: count(guard.reasserts, TIMINGS.stopReasserts),
          sticky: guard.sticky === true,
        }
      : null,
  };
}

/** Where a unit is (`{ unit, host, port, unitId }`), repaired, else undefined. */
export function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const unit = shortText(raw.unit, 280);
  const host = typeof raw.host === 'string' && HOST.test(raw.host) ? raw.host : undefined;
  const port =
    Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : DEFAULT_PORT;
  const unitId =
    Number.isInteger(raw.unitId) && raw.unitId >= UNIT_ID.min && raw.unitId <= UNIT_ID.max
      ? raw.unitId
      : undefined;
  return unit && host && unitId !== undefined ? { unit, host, port, unitId } : undefined;
}
