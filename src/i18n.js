// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Komfovent ventilation', 'Ventilation Komfovent');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Ventilation mode', 'Mode de ventilation'),
  [FEATURES.CURRENT_MODE]: both('Current mode', 'Mode en cours'),
  [FEATURES.POWER]: both('Unit on', 'Centrale en marche'),
  [FEATURES.FAN_RUNNING]: both('Fans running', 'Ventilateurs en marche'),
  [FEATURES.ECO]: both('ECO mode', 'Mode ECO'),
  [FEATURES.AUTO]: both('AUTO mode', 'Mode AUTO'),
  [FEATURES.FAULT]: both('Fault (F alarm)', 'Défaut (alarme F)'),
  [FEATURES.WARNING]: both('Warning (W alarm)', 'Avertissement (alarme W)'),
  [FEATURES.ALARM_COUNT]: both('Active alarms', 'Alarmes actives'),
  [FEATURES.ALARM_CODES]: both('Alarm codes', 'Codes d’alarme'),
  [FEATURES.TEMP_SUPPLY]: both('Supply air temperature', 'Température de l’air soufflé'),
  [FEATURES.TEMP_EXTRACT]: both('Extract air temperature', 'Température de l’air extrait'),
  [FEATURES.TEMP_OUTDOOR]: both('Outdoor air temperature', 'Température de l’air extérieur'),
  [FEATURES.TEMP_PANEL]: both('Panel temperature', 'Température du panneau'),
  [FEATURES.HUMIDITY_PANEL]: both('Panel humidity', 'Humidité du panneau'),
  [FEATURES.FAN_SUPPLY]: both('Supply fan level', 'Niveau du ventilateur de soufflage'),
  [FEATURES.FAN_EXTRACT]: both('Extract fan level', 'Niveau du ventilateur d’extraction'),
  [FEATURES.FILTER]: both('Filter clogging (%)', 'Encrassement des filtres (%)'),
  [FEATURES.EFFICIENCY]: both('Heat exchanger efficiency (%)', 'Rendement de l’échangeur (%)'),
  [FEATURES.CO2_1]: both('CO2 (sensor 1)', 'CO2 (sonde 1)'),
  [FEATURES.CO2_2]: both('CO2 (sensor 2)', 'CO2 (sonde 2)'),
  [FEATURES.HUMIDITY_1]: both('Extract humidity (sensor 1)', 'Humidité extraite (sonde 1)'),
  [FEATURES.HUMIDITY_2]: both('Extract humidity (sensor 2)', 'Humidité extraite (sonde 2)'),
  [FEATURES.START]: both('Start the unit', 'Démarrer la centrale'),
  [FEATURES.STOP]: both('Stop the unit', 'Arrêter la centrale'),
};

/** The modes (register 5). */
export const MODE_NAMES = {
  standby: both('Stand-by', 'Veille'),
  away: both('Away', 'Absence'),
  normal: both('Normal', 'Normal'),
  intensive: both('Intensive', 'Intensif'),
  boost: both('Boost', 'Boost'),
  kitchen: both('Kitchen', 'Cuisine'),
  fireplace: both('Fireplace', 'Cheminée'),
  override: both('Override', 'Forçage'),
  holiday: both('Holiday', 'Vacances'),
  'air-quality': both('Air quality', 'Qualité d’air'),
  off: both('Off', 'Arrêt'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Komfovent unit (Modbus TCP), then save.',
    'Saisissez l’adresse IP de votre centrale Komfovent (Modbus TCP), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  otherUnit: (kept, seen) =>
    both(
      `Connected, but the controller type changed (${kept} → ${seen}): another device may answer at this address. The mode and start commands are refused; if it is your unit, press "Test the connection" to accept it.`,
      `Connecté, mais le type de régulation a changé (${kept} → ${seen}) : un autre appareil répond peut-être à cette adresse. Le changement de mode et le démarrage sont refusés ; si c’est bien votre centrale, appuyez sur « Tester la connexion » pour l’accepter.`,
    ),
  accepted: (seen) =>
    both(
      `Unit accepted with the controller ${seen}: the commands follow the option again.`,
      `Centrale acceptée avec la régulation ${seen} : les commandes suivent de nouveau l’option.`,
    ),
  badUnitId: both(
    'Invalid Modbus unit id: a whole number from 1 to 255 (254 by default). Nothing is read.',
    'Identifiant d’unité Modbus invalide : un nombre entier de 1 à 255 (254 par défaut). Rien n’est lu.',
  ),
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  dataUnreadable: both(
    ' /data cannot be read: the mode and start commands are refused until a restart reads it.',
    ' /data illisible : le changement de mode et le démarrage sont refusés jusqu’à un redémarrage qui le relise.',
  ),
  stopKept: both(
    ' A stop sent from Gladys is kept: the unit read on again is stopped again (three times at most) until "Start the unit" is pressed or the unit is read on twice in a row after being seen off.',
    ' Un arrêt envoyé depuis Gladys est gardé : la centrale relue en marche est arrêtée de nouveau (trois fois au plus) jusqu’à un appui sur « Démarrer la centrale » ou deux lectures de suite en marche après l’avoir vue arrêtée.',
  ),
  stopNotApplied: both(
    ' WARNING: the stop sent from Gladys does not show on the unit after three resends; stop it on its panel.',
    ' ATTENTION : l’arrêt envoyé depuis Gladys n’apparaît pas sur la centrale après trois renvois ; arrêtez-la depuis son panneau.',
  ),
  connecting: both('Reading the unit…', 'Lecture de la centrale…'),
  waiting: (wait) =>
    both(
      `Next read of the unit in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la centrale dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, that Modbus TCP is enabled on the unit, and the Modbus unit id.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, que le Modbus TCP est activé sur la centrale, et l’identifiant d’unité Modbus.`,
    ),
  failing: (reason, wait) =>
    both(
      `The unit answered badly (${reason}); next try in ${wait.en}.`,
      `La centrale a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  summary: (values) => {
    const name = values.controller ? `Komfovent ${values.controller}` : 'Komfovent';
    if (values.power === false) {
      return both(`${name}: unit off.`, `${name} : centrale arrêtée.`);
    }
    const mode = MODE_NAMES[values.mode] ?? both('unknown mode', 'mode inconnu');
    const fault = values.fault ? both(', FAULT', ', DÉFAUT') : both('', '');
    const warning = values.warning ? both(', warning', ', avertissement') : both('', '');
    return both(
      `${name}: ${mode.en.toLowerCase()}${fault.en}${warning.en}.`,
      `${name} : ${mode.fr.toLowerCase()}${fault.fr}${warning.fr}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badButton: both('A button only takes 1: not sent.', 'Un bouton ne prend que 1 : non envoyé.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address or Modbus unit id in the configuration: not sent.',
    'Aucune adresse ou identifiant d’unité Modbus valide dans la configuration : non envoyée.',
  ),
  unitOff: both(
    'The unit is off or in stand-by: a mode would start it. Press "Start the unit" first. Not sent.',
    'La centrale est arrêtée ou en veille : un mode la relancerait. Appuyez d’abord sur « Démarrer la centrale ». Non envoyée.',
  ),
  unitStopping: both(
    'The unit is stopping: this command could start it again. Not sent.',
    'La centrale est en train de s’arrêter : cette commande pourrait la relancer. Non envoyée.',
  ),
  unitFault: both(
    'The unit shows a fault (F alarm): clear it on the unit first. Not sent.',
    'La centrale signale un défaut (alarme F) : acquittez-le d’abord sur la centrale. Non envoyée.',
  ),
  stopKept: both(
    'A stop sent from Gladys is kept: press "Start the unit" first. Not sent.',
    'Un arrêt envoyé depuis Gladys est gardé : appuyez d’abord sur « Démarrer la centrale ». Non envoyée.',
  ),
  otherUnit: both(
    'The controller type of the unit changed: another device may answer at this address. Press "Test the connection" to accept it. Not sent.',
    'Le type de régulation de la centrale a changé : un autre appareil répond peut-être à cette adresse. Appuyez sur « Tester la connexion » pour l’accepter. Non envoyée.',
  ),
  noIdentity: both(
    'The controller type of the unit could not be read just before: not sent.',
    'Le type de régulation de la centrale n’a pas pu être relu juste avant : non envoyée.',
  ),
  dataUnreadable: both(
    '/data cannot be read or written: not sent (a stop is never held back by this).',
    '/data ne peut pas être lu ou écrit : non envoyée (un arrêt n’est jamais bloqué par cela).',
  ),
  unknownMode: both(
    'The mode of the unit could not be read just before: command not sent.',
    'Le mode de la centrale n’a pas pu être relu juste avant : commande non envoyée.',
  ),
  unreadable: both('unreadable', 'illisible'),
  stopPending: both(
    'Stop not sent yet, still trying to reach the unit: check the unit in a few seconds.',
    'Arrêt pas encore envoyé, la centrale est encore en cours de connexion : vérifiez la centrale dans quelques secondes.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Another command to the unit is still running: not sent.',
    'Une autre commande vers la centrale est encore en cours : non envoyée.',
  ),
  protectMeanwhile: both(
    'The unit was stopped meanwhile: not sent.',
    'La centrale a été arrêtée entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The unit answered too slowly to send the command in time: not sent.',
    'La centrale a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L’état de la centrale n’a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The unit refused the command (${reason}): not applied.`,
      `La centrale a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The unit could not be reached (${reason}): command not sent.`,
      `La centrale n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la centrale dans quelques secondes.`,
    ),
  notYetApplied: both(
    'Command sent, the unit still reads the state from before: not applied yet, check in a few seconds.',
    'Commande envoyée, la centrale relit encore l’état d’avant : pas encore appliquée, vérifiez dans quelques secondes.',
  ),
};
