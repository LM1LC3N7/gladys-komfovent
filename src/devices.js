// -----------------------------------------------------------------------------
// The unit -> one Gladys device and its states (pure).
//
// `ext:<selector>:komfovent:unit`: one device per integration. FROZEN RULE:
// the Modbus map of the Komfovent controllers gives no serial number, so the
// device is keyed by the unit of the configuration, never by its IP address
// (a new address keeps the device and its history). The feature roles (the
// last part of their external ids) are published forever: never rename them.
// Every role is always built, so a republished device never loses a feature.
//
// No switch, no writable binary, no writable fan: a "turn everything off"
// (Google Home, Alexa, HomeKit, MCP, `switch.*` scenes) never reaches the
// ventilation. The commands are one `text/select` (the mode: away, normal,
// intensive, boost) and two `button/push` features (start, stop); the mode
// and the start are refused unless the configuration allows the commands;
// the stop is never held back by the option (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor, percent on
// humidity-sensor and fan, ppm on co2-sensor. The filter clogging and the
// heat exchanger efficiency have no category of their own: `unknown`
// integer sensors whose name says "%". The air flows (m³/h, l/s or % by
// controller and setting) are not published (no matching unit in the core).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COMMANDS, FEATURES, MODES, RANGES, READ_MODES } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

export const SERVICE = 'komfovent';
export const PLATFORM_ID = 'unit';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: RANGES.temperature[0],
  max: RANGES.temperature[1],
});
const humidity = sensor({
  category: C.HUMIDITY_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.PERCENT,
  min: 0,
  max: 100,
});
const co2 = sensor({
  category: C.CO2_SENSOR,
  type: T.SENSOR.INTEGER,
  unit: U.PPM,
  min: RANGES.co2[0],
  max: RANGES.co2[1],
});
const fanLevel = sensor({
  category: C.FAN,
  type: T.FAN.PERCENT,
  unit: U.PERCENT,
  min: 0,
  max: 100,
});
const percent = sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 100 });
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.MODE]: select,
  [FEATURES.CURRENT_MODE]: text,
  [FEATURES.POWER]: binary,
  [FEATURES.FAN_RUNNING]: binary,
  [FEATURES.ECO]: binary,
  [FEATURES.AUTO]: binary,
  [FEATURES.FAULT]: binary,
  [FEATURES.WARNING]: binary,
  [FEATURES.ALARM_COUNT]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 10 }),
  [FEATURES.ALARM_CODES]: text,
  [FEATURES.TEMP_SUPPLY]: temperature,
  [FEATURES.TEMP_EXTRACT]: temperature,
  [FEATURES.TEMP_OUTDOOR]: temperature,
  [FEATURES.TEMP_PANEL]: temperature,
  [FEATURES.HUMIDITY_PANEL]: humidity,
  [FEATURES.FAN_SUPPLY]: fanLevel,
  [FEATURES.FAN_EXTRACT]: fanLevel,
  [FEATURES.FILTER]: percent,
  [FEATURES.EFFICIENCY]: percent,
  [FEATURES.CO2_1]: co2,
  [FEATURES.CO2_2]: co2,
  [FEATURES.HUMIDITY_1]: humidity,
  [FEATURES.HUMIDITY_2]: humidity,
  [FEATURES.START]: button,
  [FEATURES.STOP]: button,
};

export const ROLES = Object.keys(DEFINITIONS);

/** The value read for each numeric or binary sensor role. */
const VALUE_OF = {
  [FEATURES.POWER]: 'power',
  [FEATURES.FAN_RUNNING]: 'fanRunning',
  [FEATURES.ECO]: 'eco',
  [FEATURES.AUTO]: 'auto',
  [FEATURES.FAULT]: 'fault',
  [FEATURES.WARNING]: 'warning',
  [FEATURES.ALARM_COUNT]: 'alarmCount',
  [FEATURES.TEMP_SUPPLY]: 'supply',
  [FEATURES.TEMP_EXTRACT]: 'extract',
  [FEATURES.TEMP_OUTDOOR]: 'outdoor',
  [FEATURES.TEMP_PANEL]: 'panelTemperature',
  [FEATURES.HUMIDITY_PANEL]: 'panelHumidity',
  [FEATURES.FAN_SUPPLY]: 'fanSupply',
  [FEATURES.FAN_EXTRACT]: 'fanExtract',
  [FEATURES.FILTER]: 'filter',
  [FEATURES.EFFICIENCY]: 'efficiency',
};

/** The air quality sensors: their value, their type (read in another block), the role by type. */
const AQ = [
  { value: 'aq1', type: 'aq1Type', co2: FEATURES.CO2_1, humidity: FEATURES.HUMIDITY_1 },
  { value: 'aq2', type: 'aq2Type', co2: FEATURES.CO2_2, humidity: FEATURES.HUMIDITY_2 },
];

export const unitIds = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[1]) ? match[1] : undefined;
}

/** The Gladys device of the unit. */
export function buildDevice(gladys, { language, controller }) {
  const ids = unitIds(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: controller ? `Komfovent ${controller}` : 'Komfovent',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.MODE
        ? {
            supported_options: MODES.map((value, index) => ({
              value,
              label: word(MODE_NAMES[value], language),
              sort_order: index,
            })),
          }
        : {}),
    })),
    params: [{ name: 'protocol', value: 'Modbus TCP' }],
  };
}

/** Whether a role is a command, and which. */
export const commandOf = (role) => (Object.hasOwn(COMMANDS, role) ? COMMANDS[role] : undefined);

/**
 * The states of the values read this time (a value not read is left out:
 * Gladys keeps its last one, never republished as new). A value outside the
 * bounds of its feature is dropped. Texts are stable English keys, whatever
 * the language (scenes keep working).
 */
export function deviceStates(ids, values) {
  const states = [];
  // The list only shows its options: another mode (kitchen, off…) does not change it.
  if (MODES.includes(values.mode)) {
    states.push({ device_feature_external_id: ids.feature(FEATURES.MODE), text: values.mode });
  }
  if (READ_MODES.includes(values.mode)) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.CURRENT_MODE),
      text: values.mode,
    });
  }
  if (
    typeof values.alarmCodes === 'string' &&
    /^(none|[FW]\d{1,3}(, [FW]\d{1,3})*)$/.test(values.alarmCodes)
  ) {
    states.push({
      device_feature_external_id: ids.feature(FEATURES.ALARM_CODES),
      text: values.alarmCodes,
    });
  }
  const numbers = {};
  for (const [role, key] of Object.entries(VALUE_OF)) {
    numbers[role] = values[key];
  }
  // An air quality sensor only with its type read this time: CO2 in ppm, humidity in %.
  for (const aq of AQ) {
    const type = values[aq.type];
    if (type === 'co2') numbers[aq.co2] = values[aq.value];
    if (type === 'humidity') numbers[aq.humidity] = values[aq.value];
  }
  for (const [role, raw] of Object.entries(numbers)) {
    let value = raw;
    if (typeof value === 'boolean') value = value ? 1 : 0;
    const { min, max } = DEFINITIONS[role];
    if (Number.isFinite(value) && value >= min && value <= max) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
