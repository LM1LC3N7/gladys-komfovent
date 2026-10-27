// -----------------------------------------------------------------------------
// The integration: the unit typed in the configuration (its IP address and
// Modbus unit id), one read of its registers every poll interval over one
// Modbus TCP connection, the Gladys device and its states, the transport
// badge, the "Test the connection" button, and the commands. index.js only
// wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"), one request at a time on it:
// a poll is one session of five requests, closed after; a command takes the
// line from a poll (the poll is dropped, nothing of it published); "Stop the
// unit" takes it from anything.
//
// Reads follow the rules learnt on the previous modules:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written at most once a minute, BEFORE the read);
//     a reconnection during a read joins it;
//   - an answer that arrives for an old configuration (generation) publishes
//     nothing and sets no status; a read begun before a command left is not
//     applied; a value not read this time is never republished as new;
//   - a secondary block (alarms, sensor types, firmware) that fails (an
//     exception, a timeout, a closed connection, a wrong answer) never costs
//     the values read before it.
//
// Commands (mode, start):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before the write (nothing runs in between);
//   - decided on a fresh read in the same session (on/off, mode, status bits,
//     controller type), never on the state in memory; refused when a value
//     cannot be read, on a fault (F alarm), while the unit is stopping, when
//     the controller type differs from the one learnt, when /data cannot be
//     read; the mode is refused on a unit that is off or in stand-by (it would
//     start it) and while a stop sent from Gladys is kept; not written when
//     already so (unless a guard says a previous command may not show yet);
//   - written within 3.5 s of the click or refused unsent; confirmed only by
//     the echo of the write and a read back equal to the value asked, by
//     4.3 s; a read back equal to the state before is "not applied yet";
//     else "sent, without confirmation" and spaced reads; a Modbus exception
//     1-3 is "refused by the unit", any other code "sent, without
//     confirmation"; never retried; one at a time;
//   - the ack never waits for a publication to Gladys.
//
// "Stop the unit" protects (register 1 = 0): never held back by the option,
// another command, a read in progress or stuck, a failed read, a backoff, the
// controller type, /data or a configuration not read yet; tried again until
// 3.5 s after the press (idempotent write); cancels a command not written
// yet. It is then KEPT (in /data, with its address): never lifted by the
// time, only by "Start the unit" pressed with the option, or by the unit read
// on twice in a row after it was seen off (started on its panel). While kept,
// a poll that reads the unit on before it was seen off (or after a start
// that may still land) sends it again, three times at most. A stop that may
// not have landed when the container stopped is sent again at start from
// /data, before the configuration is read.
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  BLOCKS,
  BLOCK_OF,
  COMMANDS,
  FEATURES,
  LIMITS,
  NOT_APPLIED_EXCEPTIONS,
  PRESSED,
  SECOND,
  STATE_BLOCKS,
  STATUS_BITS,
  TIMINGS,
  VALUE_BLOCK,
} from './constants.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import { decodeBlock, isEcho, parseRead, readRequest, writeRequest } from './modbus/protocol.js';
import { buildDevice, commandOf, deviceStates, parseFeatureId, unitIds } from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const both = (en, fr) => ({ en, fr });

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time). */
  values: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

const STOP_PLAN = {
  role: FEATURES.STOP,
  command: COMMANDS[FEATURES.STOP],
  written: COMMANDS[FEATURES.STOP].button[0],
  expected: COMMANDS[FEATURES.STOP].button[1],
};

export class KomfoventApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'komfovent' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: nothing learnt nor written over it. */
    this.memoryUnreadable = false;
    this.memoryLoaded = false;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The time of the last read sent to the unit (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands getting ready to take the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The command in flight (one at a time), and the stop in flight. */
    this.inFlight = undefined;
    this.protecting = undefined;
    /** The end of the window of the stop in flight (a press near its end starts a new one). */
    this.protectUntil = -Infinity;
    /** Counts the stops: a command that sees it change before its write gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last start left (and was not refused by the unit). */
    this.lastStartAt = -Infinity;
    /** A start or a mode written and not confirmed yet: a stop after it is sticky. */
    this.startOpen = false;
    /** The controller read when it differs from the one kept for this unit (commands refused). */
    this.mismatch = undefined;
    /** Value key -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** The kept stop (see the header), or undefined. */
    this.stopGuard = undefined;
    /** Block key -> timeouts in a row while the unit answered the others. */
    this.timeouts = new Map();
    /** Measure block key -> when it is tried again (skipped after repeated timeouts or refusals). */
    this.skipped = new Map();
    /** The pending resend of a stop. */
    this.reassertTimer = undefined;
    /** `getConfig()` failed in `connected`: the retry timer and the failures in a row. */
    this.configTimer = undefined;
    this.configFailures = 0;
    this.connectSeq = 0;
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  // --- /data -------------------------------------------------------------------

  /** Reads /data once (again after a failure): an unreadable file is never taken for an empty one. */
  async loadMemory() {
    let raw;
    try {
      raw = await this.store.load();
    } catch (err) {
      if (!this.memoryUnreadable) {
        this.logger.warn(
          `Komfovent: /data unreadable (${err.message}); nothing is written over it`,
        );
      }
      this.memoryUnreadable = true;
      return;
    }
    const loaded = normalizeMemory(raw, this.now());
    this.memoryUnreadable = false;
    this.memoryLoaded = true;
    // What runs now wins over what was kept (a stop sent since the file was read).
    this.memory = {
      lastAttemptAt: this.memory.lastAttemptAt ?? loaded.lastAttemptAt,
      identity: this.memory.identity ?? loaded.identity,
      target: this.memory.target ?? loaded.target,
      stopGuard: this.guardRecord() ?? loaded.stopGuard,
    };
    if (!this.stopGuard && loaded.stopGuard) {
      this.stopGuard = { ...loaded.stopGuard, sentAt: this.mono(), restored: true };
      this.logger.info('Komfovent: a stop kept in /data is still kept');
    }
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      throw new Error('/data unreadable');
    }
    await this.store.save(this.memory);
  }

  /** A background save: logged on failure, never awaited by a protective path. */
  saveSoon() {
    const saving = this.saveMemory();
    saving.catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
    return saving;
  }

  /** The kept stop as /data keeps it (no date: it never ends by the time). */
  guardRecord(guard = this.stopGuard) {
    if (!guard) return null;
    const { unit, host, port, unitId, pending, seenOff, onReads, reasserts, sticky } = guard;
    return { unit, host, port, unitId, pending, seenOff, onReads, reasserts, sticky };
  }

  /** Keeps the stop guard in /data (or clears it). */
  persistStopGuard() {
    const next = this.guardRecord();
    if (JSON.stringify(next) === JSON.stringify(this.memory.stopGuard ?? null)) {
      return Promise.resolve();
    }
    this.memory.stopGuard = next;
    return this.saveSoon();
  }

  /**
   * Container start, before Gladys is reached: a stop that may not have
   * landed when the container stopped is sent again now, from /data (its
   * address), without the configuration nor a first read.
   */
  async boot() {
    await this.loadMemory();
    const guard = this.stopGuard;
    if (guard?.pending) {
      this.logger.warn('Komfovent: a stop may not have landed before the restart, sent again');
      this.protect(STOP_PLAN, this.mono(), this.guardTarget(guard)).catch((err) =>
        this.logger.warn(`Komfovent: stop sent again at start: ${err.message}`),
      );
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    if (generation !== this.generation) {
      return;
    }
    if (!this.memoryLoaded) {
      await this.loadMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    this.unit = freshUnit();
    this.mismatch = undefined;
    this.timeouts.clear();
    this.skipped.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    const target = this.configTarget();
    if (target && JSON.stringify(target) !== JSON.stringify(this.memory.target)) {
      // Where a stop goes before the configuration is read again (after a restart).
      this.memory.target = target;
      if (!this.memoryUnreadable) this.saveSoon().catch(() => {});
    }
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The unit of the configuration, as kept in /data: its address and Modbus unit id. */
  unitKey() {
    return this.config.address ? `${addressKey(this.config.address)}#${this.config.unitId}` : '';
  }

  /** Where the configuration points. */
  configTarget() {
    if (!this.config.address) return undefined;
    return {
      unit: this.unitKey(),
      host: this.config.address.host,
      port: this.config.address.port,
      unitId: this.config.unitId,
    };
  }

  guardTarget(guard) {
    return { unit: guard.unit, host: guard.host, port: guard.port, unitId: guard.unitId };
  }

  /** The kept stop, when it belongs to the unit of the configuration. */
  ownGuard() {
    return this.stopGuard && this.stopGuard.unit === this.unitKey() ? this.stopGuard : undefined;
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    // One reading of each clock: the wall time kept, as a time of the monotonic clock.
    const now = this.now();
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (now - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - now));
  }

  /**
   * A new configuration or a restart: the reads and commands of this run end.
   * A stop in flight goes on (bounded by its own deadline), unless the
   * container shuts down.
   */
  stop({ shutdown = false } = {}) {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    if (shutdown || this.active?.kind !== 'protect') {
      this.active?.abort('stopped');
    }
    this.publisher.stop();
    // Command guards belong to this address and this run only (the kept stop stays).
    this.guards.clear();
    if (this.reassertTimer) {
      this.timers.clearTimeout(this.reassertTimer);
      this.reassertTimer = undefined;
    }
    if (shutdown && this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** The container stops: everything ends, /data keeps the last state. */
  async shutdown() {
    this.stop({ shutdown: true });
    if (!this.memoryUnreadable && this.memoryLoaded) {
      this.memory.stopGuard = this.guardRecord();
      await this.saveMemory().catch(() => {});
    }
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read; when that fails, it is tried again, spaced (5 s,
   * 15 s, 30 s, then every minute), without end, with the status saying so.
   */
  async connectedWith(getConfig) {
    const seq = ++this.connectSeq;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (seq !== this.connectSeq) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `Komfovent: reading the configuration failed (${err?.message ?? 'error'}); next try in ${Math.round(wait / 1000)} s`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(age(wait)));
      if (seq !== this.connectSeq) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connectedWith(getConfig).catch(() => this.logger.error('Komfovent: start failed'));
      }, wait);
      return;
    }
    if (seq !== this.connectSeq) return;
    this.configFailures = 0;
    await this.connected(raw);
  }

  /**
   * The configuration read. The first time, start; after a reconnection,
   * resend what Gladys keeps in memory only (status, Discovery list, badge)
   * and the last states, without reading the unit.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address or unit id restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid ||
      next.unitId !== this.config.unitId
    );
  }

  /** A new interval: the next read follows it, counted from the last read. */
  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  async configUpdated(raw = {}) {
    if (!this.started) {
      // Before the first configuration was read: this one starts.
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Komfovent commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection to `target`; the line is held
   * until it ends. `retryUntil`: a refused connection is tried again every
   * 250 ms until then (the unit may free its place a moment after our own
   * close); nothing is sent before the connection, so this never repeats a
   * command.
   */
  async useLine(kind, timeoutMs, fn, { retryUntil, target = this.configTarget() } = {}) {
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      if (!target) {
        throw new ModbusError(ERROR_KINDS.UNREACHABLE, 'no address');
      }
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: target.host,
          port: target.port,
          unitId: target.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      const other = record.session?.otherUnitId;
      if (other !== undefined && other !== this.otherUnitIdLogged) {
        this.otherUnitIdLogged = other;
        this.logger.info(
          `Komfovent: the unit answers with Modbus unit id ${other} (accepted; ${target?.unitId} asked)`,
        );
      }
      record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** One block read in `session`: its values (only those plausible). */
  async readBlock(session, key, options) {
    const block = BLOCK_OF[key];
    const pdu = await session.request(readRequest(block), options);
    const data = parseRead(block, pdu);
    if (data === undefined) {
      // An answer of the wrong size: the session is not trusted any more.
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    return decodeBlock(block, data);
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval after the last one began; never sooner. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    const now = this.mono();
    // Start to start: the period is the interval, whatever a read lasted.
    let wait = delay ?? (u.online === false ? u.wait : this.due - now);
    // Never sooner than the interval after the last read; capped at the interval
    // (a clock jump never stops the reads).
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - now), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Komfovent refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /**
   * Keeps the time of this read; when the write of the minute is due, in
   * /data BEFORE the read (a container stopped during the read keeps it). At
   * most one write a minute; a failed write never stops the read.
   */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      if (!this.memoryUnreadable) {
        // Waited for a moment only: a /data that never answers never stops the reads.
        let timer;
        await Promise.race([
          this.saveMemory().catch((err) =>
            this.logger.warn(`Saving the state to /data failed: ${err.message}`),
          ),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, TIMINGS.attemptSaveWait);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
    }
  }

  async run() {
    const generation = this.generation;
    if (!this.config.address) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command or a stop holds the line: the poll is tried again a second later.
      this.schedule(TIMINGS.busyRetry);
      return;
    }
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // Taken while /data kept the time of this read: never two connections.
      this.schedule(TIMINGS.busyRetry);
      return;
    }
    let values;
    let failure;
    try {
      values = await this.useLine('read', TIMINGS.connectTimeout, (session) =>
        this.readAll(session),
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      // A command took the line: nothing of this read is applied.
      this.logger.debug('Komfovent: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('Komfovent: read begun before a command, not applied');
    } else {
      this.applyRead(values);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * Every block, one after the other. A block that times out while the unit
   * answered the ones before ends the read (the session is gone): what was
   * read is kept. A block refused by the unit (Modbus exception) leaves its
   * values unknown this time. A state block (on/off, mode, status) is never
   * skipped; a measure block that times out three reads in a row, or is
   * refused, is skipped and tried again every hour (one log line when it is
   * skipped). A state block that timed out is read last at the next read.
   */
  async readAll(session) {
    const values = {};
    let answered = 0;
    const read = new Set();
    const stateRead = () => [...STATE_BLOCKS].every((key) => read.has(key));
    const late = (b) => STATE_BLOCKS.has(b.key) && this.timeouts.has(b.key);
    const order = [...BLOCKS.filter((b) => !late(b)), ...BLOCKS.filter(late)];
    for (const block of order) {
      const skippedUntil = this.skipped.get(block.key);
      if (skippedUntil !== undefined && this.mono() < skippedUntil) {
        continue;
      }
      let decoded;
      try {
        decoded = await this.readBlock(session, block.key, { timeoutMs: TIMINGS.requestTimeout });
      } catch (err) {
        if (err.kind === ERROR_KINDS.REFUSED) {
          answered += 1;
          if (STATE_BLOCKS.has(block.key)) {
            this.logger.warn(`Komfovent: block ${block.key} refused (${errorReason(err)})`);
          } else {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Komfovent: block ${block.key} refused (${errorReason(err)}), tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          }
          continue;
        }
        if (
          !STATE_BLOCKS.has(block.key) &&
          stateRead() &&
          [ERROR_KINDS.CLOSED, ERROR_KINDS.PROTOCOL].includes(err.kind)
        ) {
          // A secondary block that ends the session (closed, wrong answer) never
          // costs the values read before it: skipped, tried again every hour; the
          // next read starts afresh on a new connection.
          if (skippedUntil === undefined) {
            this.logger.warn(
              `Komfovent: block ${block.key} failed (${errorReason(err)}), tried again every hour`,
            );
          }
          this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          return values;
        }
        if (err.kind === ERROR_KINDS.TIMEOUT && answered > 0) {
          const count = (this.timeouts.get(block.key) ?? 0) + 1;
          this.timeouts.set(block.key, count);
          if (STATE_BLOCKS.has(block.key)) {
            this.logger.warn(`Komfovent: block ${block.key} did not answer`);
          } else if (count >= LIMITS.blockTimeouts) {
            if (skippedUntil === undefined) {
              this.logger.warn(
                `Komfovent: block ${block.key} never answers, tried again every hour`,
              );
            }
            this.skipped.set(block.key, this.mono() + TIMINGS.blockRetry);
          } else {
            this.logger.warn(`Komfovent: block ${block.key} did not answer`);
          }
          return values;
        }
        throw err;
      }
      answered += 1;
      this.timeouts.delete(block.key);
      this.skipped.delete(block.key);
      read.add(block.key);
      Object.assign(values, decoded);
    }
    return values;
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead(values) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.values = values;
    this.checkIdentity(values);
    this.observe(values);
  }

  /**
   * The light identity of the unit: its controller type (C6, C6M, C8), learnt
   * at the first read and kept in /data for this address and unit id.
   * Another one read means another device may answer at the address: the
   * commands (except the stop) are refused until the test button accepts it.
   * An unreadable value is never "another unit"; nothing is learnt over an
   * unreadable /data.
   */
  checkIdentity(values) {
    const seen = values.controller;
    if (seen === undefined || this.memoryUnreadable) {
      return;
    }
    const kept = this.memory.identity;
    if (!kept || kept.unit !== this.unitKey()) {
      this.memory.identity = { unit: this.unitKey(), controller: seen };
      this.mismatch = undefined;
      this.saveSoon().catch(() => {});
      return;
    }
    if (kept.controller === seen) {
      this.mismatch = undefined;
      return;
    }
    if (this.mismatch !== seen) {
      this.logger.warn(
        `Komfovent: controller type changed (${kept.controller} -> ${seen}); commands refused until the test button accepts the unit`,
      );
    }
    this.mismatch = seen;
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`Komfovent: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    if (!c.address) {
      if (c.invalid) return T.invalid(c.invalid);
      return c.badUnitId ? T.badUnitId : T.noHost;
    }
    let text;
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      text = [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
        ? T.unreachable(addressKey(c.address), wait)
        : T.failing(u.error ?? 'error', wait);
    } else if (u.online === true && this.mismatch !== undefined) {
      text = T.otherUnit(this.memory.identity?.controller ?? '?', this.mismatch);
    } else if (u.online === undefined) {
      text =
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting;
    } else {
      text = T.connected(T.summary(u.values ?? {}));
    }
    const guard = this.ownGuard();
    if (guard) {
      const exhausted = !guard.seenOff && guard.reasserts >= TIMINGS.stopReasserts;
      text = join(text, exhausted ? T.stopNotApplied : T.stopKept);
    }
    if (this.memoryUnreadable) {
      text = join(text, T.dataUnreadable);
    }
    return both(text.en.replace(/ {2,}/g, ' '), text.fr.replace(/ {2,}/g, ' '));
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = unitIds(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The device, once the unit answered (every feature, always). */
  async publishDevices() {
    if (this.unit.online !== true) {
      return;
    }
    const controller =
      this.memory.identity?.unit === this.unitKey() ? this.memory.identity.controller : undefined;
    const devices = [buildDevice(this.gladys, { language: this.config.language, controller })];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      unitIds(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  queueStates(created) {
    if (this.unit.online === true && this.unit.values) {
      this.queueValues(this.unit.values, created);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    if (this.mismatch !== undefined) {
      // Accepts exactly the controller shown in the status, without a read.
      const accepted = this.mismatch;
      const previous = this.memory.identity;
      this.memory.identity = { unit: this.unitKey(), controller: accepted };
      try {
        await this.saveMemory();
      } catch {
        this.memory.identity = previous;
        return join(this.status(), T.dataUnreadable);
      }
      this.mismatch = undefined;
      this.logger.info(`Komfovent: unit accepted with the controller ${accepted}`);
      await this.updateStatus();
      return T.accepted(accepted);
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    const now = this.mono();
    if (now < this.due) {
      const waited = T.waiting(age(this.due - now));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(now - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    let written;
    let expected;
    if (command.button) {
      // Strictly 1: null, '', true, 0 or "on" never press a button.
      if (value !== PRESSED && value !== String(PRESSED)) {
        throw this.refusal(ERRORS.badButton);
      }
      [written, expected] = command.button;
    } else {
      // Strictly one of the values of the select: never trimmed, re-cased nor a number.
      if (typeof value !== 'string' || !Object.hasOwn(command.values, value)) {
        throw this.refusal(ERRORS.badValue);
      }
      written = command.values[value];
      expected = value;
    }
    const plan = { role, command, written, expected };
    if (command.protective) {
      // The address of the configuration, else (configuration not read yet) the
      // one the kept stop was sent to, else the last one kept in /data.
      const target =
        this.configTarget() ??
        (this.stopGuard ? this.guardTarget(this.stopGuard) : undefined) ??
        this.memory.target ??
        undefined;
      if (!target) {
        throw this.refusal(ERRORS.noHost);
      }
      return this.protect(plan, received, target);
    }
    if (!this.config.address) {
      throw this.refusal(ERRORS.noHost);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight) {
      throw this.refusal(ERRORS.busy);
    }
    if (this.protecting) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    const promise = this.command(plan, received);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values, { fromCommand = false } = {}) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.observe(values, { fromCommand });
    this.queueValues(values);
    // Shown in the background: the ack never waits for Gladys.
    this.flush().catch(() => {});
  }

  async command(plan, received) {
    const generation = this.generation;
    const seq = this.protectSeq;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    // The checks before the write, on the latest configuration.
    const check = () => {
      if (!this.config.allowCommands) {
        throw this.refusal(ERRORS.disabled);
      }
      if (generation !== this.generation || !this.config.address) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (seq !== this.protectSeq) {
        throw this.refusal(ERRORS.protectMeanwhile);
      }
    };
    const state = { written: false, seq };
    this.reserved += 1;
    try {
      if (this.memoryUnreadable) {
        throw this.refusal(ERRORS.dataUnreadable);
      }
      if (plan.command.needsRunning && this.ownGuard()) {
        // A mode would start a unit stopped from Gladys: only "Start the unit" lifts the stop.
        throw this.refusal(ERRORS.stopKept);
      }
      await this.takeLine(['read']);
      if (this.active) {
        throw this.refusal(this.active.kind === 'protect' ? ERRORS.protectMeanwhile : ERRORS.busy);
      }
      check();
      const connectBudget = Math.min(
        TIMINGS.commandConnectMax,
        sendBy - TIMINGS.commandMinSend - TIMINGS.commandMinRead - this.mono(),
      );
      if (connectBudget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      return await this.useLine('command', connectBudget, (session) =>
        this.commandSession(session, plan, { check, sendBy, answerBy, state }),
      );
    } catch (err) {
      throw this.commandError(err, plan, state);
    } finally {
      this.reserved -= 1;
      if (state.liftSaved && !state.written && this.stopGuard) {
        // The start never left: /data keeps the stop again.
        this.memory.stopGuard = undefined;
        this.persistStopGuard().catch(() => {});
      }
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, plan, state) {
    if (err instanceof Refusal) {
      return err;
    }
    if (err?.beforeSend) {
      return err;
    }
    const reason = errorReason(err);
    const what = `${plan.role} ${plan.written}`;
    // Only the write says whether the command may have left (a read never does).
    if (!state.written) {
      this.logger.warn(`Komfovent: command NOT sent (${what}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          state.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      // A Modbus exception to the write: the unit did not apply it.
      this.logger.warn(`Komfovent: command refused by the unit (${what}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the unit: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    const key = plan.command.read;
    this.guards.set(key, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
    this.logger.warn(`Komfovent: command sent, NOT confirmed (${plan.role}): ${reason}`);
    if (state.backEqualsBefore) {
      return this.refusal(ERRORS.notYetApplied);
    }
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  async commandSession(session, plan, { check, sendBy, answerBy, state }) {
    const { command } = plan;
    // The state just before acting, read now in this session, never the one in memory.
    const keys = ['power', 'mode', 'status', 'controller'];
    const blocks = [...new Set(keys.map((key) => VALUE_BLOCK[key]))];
    const fresh = {};
    for (const key of blocks) {
      const budget = Math.min(
        TIMINGS.commandReadMax,
        sendBy - TIMINGS.commandMinSend - this.mono(),
      );
      if (budget < TIMINGS.commandMinRead) {
        throw this.refusal(ERRORS.tooSlow);
      }
      try {
        Object.assign(fresh, await this.readBlock(session, key, { timeoutMs: budget }));
      } catch (err) {
        if (err.kind === ERROR_KINDS.ABORTED) {
          throw err;
        }
        throw this.refusal(ERRORS.unknownState(errorReason(err)));
      }
    }
    if (fresh.controller === undefined) {
      throw this.refusal(ERRORS.noIdentity);
    }
    if (fresh.mode === undefined && command.needsRunning) {
      throw this.refusal(ERRORS.unknownMode);
    }
    if (fresh.power === undefined || fresh.status === undefined) {
      throw this.refusal(ERRORS.unknownState(word(ERRORS.unreadable, this.config.language)));
    }
    check();
    // The light identity read in the same session: another unit refuses the command.
    this.checkIdentity(fresh);
    if (this.mismatch !== undefined) {
      throw this.refusal(ERRORS.otherUnit);
    }
    if (!this.memory.identity || this.memory.identity.unit !== this.unitKey()) {
      // Not learnt (a read of /data failed meanwhile): incomplete identity.
      throw this.refusal(ERRORS.noIdentity);
    }
    // A fresh read of a command never sends a stop again.
    this.noteValues(fresh, { fromCommand: true });
    if (fresh.status & STATUS_BITS.alarmF) {
      throw this.refusal(ERRORS.unitFault);
    }
    if (fresh.status & STATUS_BITS.stopping) {
      throw this.refusal(ERRORS.unitStopping);
    }
    if (command.needsRunning) {
      // A unit off or in stand-by is never started by a mode.
      if (fresh.power !== true || fresh.mode === 'standby' || fresh.mode === 'off') {
        throw this.refusal(ERRORS.unitOff);
      }
      if (this.ownGuard()) {
        throw this.refusal(ERRORS.stopKept);
      }
    }
    if (command.starts && this.ownGuard()) {
      // The start lifts the kept stop: /data must forget it BEFORE the first byte
      // (a restart would else stop the unit again), or nothing is sent.
      this.memory.stopGuard = null;
      try {
        await this.saveMemory();
      } catch {
        this.memory.stopGuard = this.guardRecord();
        throw this.refusal(ERRORS.dataUnreadable);
      }
      state.liftSaved = true;
      check();
    }
    state.from = fresh[command.read];
    if (state.from === plan.expected && !this.guardActive(command.read)) {
      // Already so: nothing sent (a start still lifts the kept stop: the user's latest wish).
      if (command.starts && this.ownGuard()) {
        this.liftStopGuard('start pressed, unit already on');
      }
      this.logger.info(`Komfovent: ${plan.role} already so, nothing sent`);
      return;
    }
    this.logger.info(`Komfovent: ${plan.role} (${plan.written})`);
    const request = writeRequest(command.write, plan.written);
    const previousStart = this.lastStartAt;
    const previousOpen = this.startOpen;
    const previousGuard = this.stopGuard;
    let echo;
    try {
      echo = await session.request(request, {
        timeoutMs: Math.max(100, answerBy - this.mono()),
        startBy: sendBy,
        beforeSend: () => {
          // The option, the configuration and a stop, checked right before the write.
          check();
          state.written = true;
          this.lastSentAt = this.mono();
          // The latest wish: a kept stop is lifted right before the synchronous write of a start.
          this.startOpen = true;
          if (command.starts) {
            this.lastStartAt = this.mono();
            if (this.stopGuard && this.stopGuard.unit === this.unitKey()) {
              this.stopGuard = undefined;
            }
          }
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(err.code)) {
        // Refused by the unit (illegal function, address or value): not applied,
        // and never counts as the latest start. Other exception codes (device
        // failure, acknowledge, busy) may be applied: "sent, without confirmation".
        state.refused = true;
        this.lastStartAt = previousStart;
        this.startOpen = previousOpen;
        if (command.starts && previousGuard && !this.stopGuard) {
          // The start was not applied: the unit stays stopped, and the stop stays kept.
          this.stopGuard = previousGuard;
          this.persistStopGuard().catch(() => {});
        }
      }
      throw err;
    }
    if (!isEcho(request, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
    }
    // Confirmed only by the value read back equal to the value asked.
    const left = answerBy - this.mono();
    if (left < 50) {
      throw new ModbusError(ERROR_KINDS.TIMEOUT, 'no time left to read back', { sent: true });
    }
    const back = (await this.readBlock(session, VALUE_BLOCK[command.read], { timeoutMs: left }))[
      command.read
    ];
    if (back !== plan.expected) {
      if (back !== undefined) {
        state.backEqualsBefore = back === state.from;
        this.noteValues({ [command.read]: back });
      }
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'read back differs', { sent: true });
    }
    this.guards.delete(command.read);
    this.startOpen = false;
    this.noteValues({ [command.read]: back });
    this.logger.info(`Komfovent: ${plan.role} confirmed by the unit`);
  }

  // --- The stop (protective) -----------------------------------------------

  /** A second press while one runs joins it. */
  async protect(plan, received, target = this.configTarget(), { reassert = false } = {}) {
    if (this.protecting) {
      if (this.protectUntil - this.mono() >= TIMINGS.stopJoinMin) {
        return this.protecting;
      }
      // The stop running has almost no time left: a new one follows it.
      await this.protecting.catch(() => {});
      return this.protect(plan, this.mono(), target, { reassert });
    }
    this.protectUntil = received + TIMINGS.commandSendBy;
    const promise = this.sendStop(plan, received, target, { reassert });
    this.protecting = promise;
    try {
      return await promise;
    } finally {
      if (this.protecting === promise) {
        this.protecting = undefined;
      }
    }
  }

  /**
   * Never held back: takes the line from anything, one write, without a
   * fresh read; a refused connection is tried again every 250 ms until 3.5 s
   * after the click (nothing is sent before it); the echo of the write and
   * register 1 read back confirm it. Answered by 4.3 s; still running then,
   * it goes on, bounded by its connection (3 s) and two answers (2 s each),
   * and the answer says whether it was written yet. Kept afterwards (see the
   * header).
   */
  async sendStop(plan, received, target, { reassert = false } = {}) {
    // A command not written yet gives way (checked right before its write).
    this.protectSeq += 1;
    // A start or a mode that may have left before this stop and is not
    // confirmed may still be applied after it: the stop is then sticky (sent
    // again when the unit reads on, even after it was seen off).
    const previous = this.stopGuard?.unit === target.unit ? this.stopGuard : undefined;
    const sticky =
      this.startOpen ||
      (this.guardActive('power') && this.guards.get('power').expected === true) ||
      this.guardActive('mode') ||
      Boolean(previous?.sticky);
    // Kept before the first byte; /data is given a short moment, never awaited longer.
    this.stopGuard = {
      ...target,
      sentAt: this.mono(),
      pending: true,
      seenOff: false,
      onReads: 0,
      // A press starts the count again; a resend by the reads keeps it.
      reasserts: reassert ? (previous?.reasserts ?? 0) : 0,
      sticky,
    };
    const saved = this.persistStopGuard().catch(() => {});
    let saveTimer;
    await Promise.race([
      saved,
      new Promise((resolve) => {
        saveTimer = this.timers.setTimeout(resolve, TIMINGS.stopSaveWait);
      }),
    ]);
    this.timers.clearTimeout(saveTimer);
    const guard = this.stopGuard;
    const state = { written: false, sentAt: undefined };
    const retryUntil = received + TIMINGS.commandSendBy;
    // Writing register 1 = 0 is idempotent: a connection closed, a timeout or a
    // wrong answer is tried again every 250 ms until 3.5 s after the press.
    const attempt = (session) =>
      (async () => {
        const request = writeRequest(plan.command.write, plan.written);
        const echo = await session.request(request, {
          timeoutMs: Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono())),
          beforeSend: () => {
            state.written = true;
            state.sentAt = this.mono();
            this.lastSentAt = this.mono();
            // The stop now carries a start not confirmed (its sticky flag).
            this.startOpen = false;
          },
        });
        if (!isEcho(request, echo)) {
          session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
          throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', {
            sent: true,
          });
        }
        return (await this.readBlock(session, VALUE_BLOCK[plan.command.read]))[plan.command.read];
      })();
    const AGAIN = [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL];
    this.reserved += 1;
    const sending = (async () => {
      try {
        await this.takeLine(['read', 'command', 'protect']);
        for (;;) {
          try {
            return await this.useLine('protect', TIMINGS.connectTimeout, attempt, {
              retryUntil,
              target,
            });
          } catch (err) {
            const again =
              AGAIN.includes(err?.kind) && this.mono() + TIMINGS.connectRetry < retryUntil;
            if (!again) {
              throw err;
            }
            await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
          }
        }
      } finally {
        this.reserved -= 1;
      }
    })();
    this.logger.info(`Komfovent: stop${sticky ? ' (after a start or mode not confirmed)' : ''}`);
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const outcome = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        (back) => resolve({ back }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    // The guard may have been lifted meanwhile (a start pressed after this stop).
    const own = this.stopGuard === guard;
    if (outcome.back === plan.expected) {
      if (own) {
        guard.pending = false;
        guard.seenOff = true;
        guard.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      this.guards.delete(plan.command.read);
      if (sticky) {
        this.followUp();
      }
      if (target.unit === this.unitKey()) {
        this.noteValues({ [plan.command.read]: outcome.back });
      }
      this.logger.info('Komfovent: stop confirmed by the unit');
      return;
    }
    // Not confirmed: kept pending, the next reads send it again.
    this.followUp();
    if (outcome.late) {
      sending
        .then((back) => {
          if (back === plan.expected && this.stopGuard === guard) {
            guard.pending = false;
            guard.seenOff = true;
            this.persistStopGuard().catch(() => {});
          }
        })
        .catch((err) =>
          this.logger.warn(`Komfovent: stop failed after the ack (${errorReason(err)})`),
        );
      if (!state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(
        ERRORS.sentUnconfirmed(
          word(both('no answer yet', 'pas encore de réponse'), this.config.language),
        ),
      );
    }
    if (outcome.err) {
      const reason = errorReason(outcome.err);
      this.logger.warn(`Komfovent: stop failed (${reason})`);
      if (!state.written) {
        throw this.refusal(ERRORS.notSent(reason));
      }
      if (
        outcome.err.kind === ERROR_KINDS.REFUSED &&
        NOT_APPLIED_EXCEPTIONS.has(outcome.err.code)
      ) {
        throw this.refusal(ERRORS.refused(reason));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (outcome.back !== undefined && target.unit === this.unitKey()) {
      this.noteValues({ [plan.command.read]: outcome.back });
    }
    throw this.refusal(
      ERRORS.sentUnconfirmed(word(both('still on', 'toujours en marche'), this.config.language)),
    );
  }

  /** The kept stop ends (a start pressed, or the unit started elsewhere). */
  liftStopGuard(reason) {
    if (!this.stopGuard) return;
    this.logger.info(`Komfovent: kept stop lifted (${reason})`);
    this.stopGuard = undefined;
    this.persistStopGuard().catch(() => {});
  }

  // --- Guards --------------------------------------------------------------------

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards: a command guard lifts when the value moved
   * from the start state to the one asked (never on an unknown value). The
   * kept stop, on a poll of its own unit only (never a command's fresh read):
   * off read -> seen off; on read before it was seen off (or after a start
   * or mode that may still land) -> sent again, three times at most; on read
   * twice in a row after it was seen off -> started elsewhere, lifted. An
   * unknown value changes nothing but the count of "on" reads in a row.
   */
  observe(values, { fromCommand = false } = {}) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
      }
    }
    const stop = this.ownGuard();
    if (!stop || fromCommand) {
      return;
    }
    if (this.lastStartAt > stop.sentAt) {
      this.liftStopGuard('start pressed after the stop');
      return;
    }
    if (values.power === false) {
      if (!stop.seenOff || stop.onReads !== 0 || stop.pending) {
        stop.seenOff = true;
        stop.pending = false;
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      return;
    }
    if (values.power !== true) {
      if (stop.onReads !== 0) {
        stop.onReads = 0;
        this.persistStopGuard().catch(() => {});
      }
      return;
    }
    if (stop.seenOff) {
      stop.onReads += 1;
      if (stop.onReads >= 2) {
        this.liftStopGuard('unit read on twice in a row after the stop, started elsewhere');
        return;
      }
      this.persistStopGuard().catch(() => {});
      if (!stop.sticky) {
        return;
      }
    }
    if (this.protecting || this.reassertTimer || stop.reasserts >= TIMINGS.stopReasserts) {
      return;
    }
    stop.reasserts += 1;
    this.persistStopGuard().catch(() => {});
    this.logger.warn('Komfovent: the unit is still on after a stop, stop sent again');
    // Not awaited, and a second after the read closed the line.
    const generation = this.generation;
    this.reassertTimer = this.timers.setTimeout(() => {
      this.reassertTimer = undefined;
      if (generation !== this.generation || this.ownGuard() !== stop) {
        return;
      }
      this.protect(STOP_PLAN, this.mono(), this.guardTarget(stop), { reassert: true }).catch(
        (err) => this.logger.warn(`Komfovent: stop sent again: ${err.message}`),
      );
    }, TIMINGS.reassertDelay);
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Komfovent refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
