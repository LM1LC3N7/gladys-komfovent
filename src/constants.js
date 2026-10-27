// -----------------------------------------------------------------------------
// Komfovent constants: the Modbus TCP map of the C6, C6M and C8 controllers,
// feature roles, limits and timings.
//
// The controllers answer Modbus TCP on port 502, without authentication. The
// registers are those Komfovent publishes ("Description of C6 / C6M controller
// Modbus", M-C6 / C6M_24-10, firmware X.X.X.18 and above; "Modbus connection
// C8", 24-10), as hass-komfovent (MIT) reads and writes them: register number
// N is protocol address N - 1, holding registers only (functions 3, 6). Only
// these requests are ever sent:
//   - read holding registers 1..34 (on/off, ECO, AUTO, current mode, flow units);
//   - read holding registers 900..955 (status bits, temperatures in tenths of
//     a degree, fan levels in tenths of a percent, filter clogging, heat
//     exchanger efficiency, panel 1 and air quality sensors);
//   - read holding registers 600..610 (active alarms);
//   - read holding registers 200..214 (the types of the air quality sensors);
//   - read holding registers 1000..1001 (controller type and firmware);
//   - write single register 1 (on/off: 0 stops the unit, 1 starts it);
//   - write single register 5 (the mode: away 1, normal 2, intensive 3, boost 4).
// Nothing else is ever written: no firmware, no settings, no clock, no reset.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  WRITE_REGISTER: 0x06,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/**
 * The blocks read at each poll, in this order: the unit's state first, the
 * secondary ones last (a secondary block that fails never stops the values
 * read before it). `register`: the first register number of the manual;
 * `address`: its protocol address (register - 1). The ranges are those
 * hass-komfovent reads on every controller (C6 before function version 38
 * included), so a real unit answers them as it answers Home Assistant.
 */
export const BLOCKS = [
  { key: 'control', register: 1, count: 34 },
  { key: 'monitor', register: 900, count: 56 },
  { key: 'alarms', register: 600, count: 11 },
  { key: 'aq', register: 200, count: 15 },
  { key: 'firmware', register: 1000, count: 2 },
].map((b) => ({ ...b, fc: FC.READ_HOLDING, address: b.register - 1 }));

export const BLOCK_OF = Object.fromEntries(BLOCKS.map((b) => [b.key, b]));

/** The blocks of the unit's state (on/off, mode, status bits): never skipped. */
export const STATE_BLOCKS = new Set(['control', 'monitor']);

/** The block that holds each value a command reads. */
export const VALUE_BLOCK = {
  power: 'control',
  mode: 'control',
  status: 'monitor',
  controller: 'firmware',
};

/** Register 5 as read (index = value): the current mode, stable keys. */
export const READ_MODES = [
  'standby',
  'away',
  'normal',
  'intensive',
  'boost',
  'kitchen',
  'fireplace',
  'override',
  'holiday',
  'air-quality',
  'off',
];

/** The modes Gladys may write (register 5, "WRITE ONLY: Away = 1 … Boost = 4"). */
export const MODES = ['away', 'normal', 'intensive', 'boost'];

/** Register 900, the status bits (manual: "Status icon bit mask"). */
export const STATUS_BITS = {
  starting: 1 << 0,
  stopping: 1 << 1,
  fan: 1 << 2,
  rotor: 1 << 3,
  heating: 1 << 4,
  cooling: 1 << 5,
  heatingDenied: 1 << 6,
  coolingDenied: 1 << 7,
  flowDown: 1 << 8,
  freeHeating: 1 << 9,
  freeCooling: 1 << 10,
  alarmF: 1 << 11,
  alarmW: 1 << 12,
};

/** Registers 1000-1001: the controller type in the top four bits (hass-komfovent). */
export const CONTROLLERS = { 0: 'C6', 1: 'C6M', 2: 'C8' };

/** Registers 213 and 214: the type of the air quality sensors 1 and 2. */
export const AQ_TYPES = { 0: 'none', 1: 'co2', 2: 'voc', 3: 'humidity' };

/** Register 954: the panels connected (panel 1 alone, or both). */
export const PANEL1_CONNECTED = new Set([1, 3]);

/**
 * Modbus exception codes that mean the request was not applied (illegal
 * function, address, value). Any other code (4 device failure, 5 acknowledge,
 * 6 busy…) may come from a write the unit applies anyway: "sent, without
 * confirmation".
 */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  MODE: 'mode',
  CURRENT_MODE: 'current-mode',
  POWER: 'power',
  ECO: 'eco-mode',
  AUTO: 'auto-mode',
  FAN_RUNNING: 'fans-running',
  FAULT: 'alarm-fault',
  WARNING: 'alarm-warning',
  ALARM_COUNT: 'alarm-count',
  ALARM_CODES: 'alarm-codes',
  TEMP_SUPPLY: 'temperature-supply',
  TEMP_EXTRACT: 'temperature-extract',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_PANEL: 'temperature-panel',
  HUMIDITY_PANEL: 'humidity-panel',
  FAN_SUPPLY: 'fan-supply-level',
  FAN_EXTRACT: 'fan-extract-level',
  FILTER: 'filter-clogging',
  EFFICIENCY: 'heat-exchanger-efficiency',
  CO2_1: 'co2-sensor-1',
  CO2_2: 'co2-sensor-2',
  HUMIDITY_1: 'humidity-sensor-1',
  HUMIDITY_2: 'humidity-sensor-2',
  START: 'start',
  STOP: 'stop',
};

/**
 * The commands, by feature role: the write (protocol address), the value for
 * each choice, the value read back that confirms it. Both non-protective
 * commands need the option and no fault; `needsRunning`: refused on a unit
 * that is off, stopping or in stand-by (writing a mode there would start it);
 * `starts`: the start, which alone lifts a kept stop. `protective`: never
 * held back (stopping the unit).
 */
export const COMMANDS = {
  [FEATURES.MODE]: {
    write: { fc: FC.WRITE_REGISTER, address: 4 },
    read: 'mode',
    values: { away: 1, normal: 2, intensive: 3, boost: 4 },
    needsRunning: true,
  },
  [FEATURES.START]: {
    write: { fc: FC.WRITE_REGISTER, address: 0 },
    read: 'power',
    button: [1, true],
    starts: true,
  },
  [FEATURES.STOP]: {
    write: { fc: FC.WRITE_REGISTER, address: 0 },
    read: 'power',
    button: [0, false],
    protective: true,
  },
};

/** The value of a button press (Gladys sends 1). */
export const PRESSED = 1;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds (the manual asks for 0.5 s at least between polls). */
export const POLL_INTERVAL = {
  min: 30,
  max: 3600,
  default: 60,
};

/**
 * The Modbus unit id of the configuration. The manuals give no unit id for
 * Modbus TCP (only the RTU "protocol ID", set on the unit's web page), and
 * hass-komfovent sends none: pymodbus then sends its default, 1 (its
 * `DEFAULT_SLAVE_ID = 254` is never read). So 1, changeable in the
 * configuration; an answer carrying another unit id is accepted (client.js).
 */
export const UNIT_ID = {
  min: 1,
  max: 255,
  default: 1,
};

/** Plausible values (anything else is not a measure). */
export const RANGES = {
  /** Manual: -500..1200 tenths of a degree (C8: 30000 "sensor not used", panel -32768 "not connected"). */
  temperature: [-50, 120],
  percent: [0, 100],
  /**
   * The manuals give 0-65535 ppm; hass-komfovent drops anything over 2500 ppm.
   * 5000 keeps a badly ventilated room visible (a CO2 sensor reads up to
   * 2000-5000 ppm) while 65535 and other junk stay unknown.
   */
  co2: [0, 5000],
};

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** A measure block that times out this many reads in a row is skipped. */
  blockTimeouts: 3,
  /** At most this many alarm codes in the text (the unit lists 10). */
  alarmCodes: 10,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** A measure block skipped after repeated timeouts or refusals is tried again this often. */
  blockRetry: HOUR,
  /** A stop reaffirmed by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** `getConfig()` failed in `connected`: tried again after 5 s, 15 s, 30 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the connection, the fresh read
   * and the write must be done by 3.5 s after the click, or the command is
   * refused unsent; the read back that confirms it is awaited until 4.3 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Connecting for a command: 1.5 s at most. */
  commandConnectMax: 1_500,
  /** One fresh read of a command: 1 s at most; 0.2 s at least left to send after it. */
  commandReadMax: 1_000,
  commandMinRead: 200,
  commandMinSend: 200,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A read waits this long at most for /data to keep its time before it starts (never blocking). */
  attemptSaveWait: 500,
  /** A poll due while a command or a stop holds the line is tried again this much later. */
  busyRetry: SECOND,
  /** A stop pressed while one runs with less than this left of its window starts a new one after it. */
  stopJoinMin: SECOND,
  /** The stop waits this long at most for /data to keep it before its first byte (never blocking). */
  stopSaveWait: 150,
  /** A stop not confirmed is reaffirmed by the next reads, three times at most. */
  stopReasserts: 3,
};
