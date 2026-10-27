# TODO — Komfovent v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (lot 17) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-27): the unit by IP address and Modbus
      unit id, five holding register reads every interval over one
      connection (never sooner, even after a restart), one device, mode
      select and start button behind `allow_commands` (off), "Stop the
      unit" never held back and kept until a start, test button, docs
      en/fr, cover. Tested against a fake unit only (and a real TCP server
      of gladys-testkit at x20).
- [x] **Review r1 fixes** (2026-10-27): unit id 1 by default and another
      unit id in the answer accepted (B1); a secondary block that closes the
      connection or answers wrong keeps the values (I1); tests for the
      surviving mutants (I2); a poll due on a busy line retried 1 s later
      (I3); the stop goes to the kept address when the configuration is
      invalid (I4); minors: CO2 bound explained, outdoor humidity sensor
      documented, a start refused by the unit keeps the stop, a press resets
      the resends, a press at the end of a running stop starts a new one,
      /data that never answers no longer holds a read (500 ms), one wall
      clock reading in `firstWait`. Tests `r1 …` in `test/app.test.js`.
- [ ] **Milestone 2 — real unit**: run against a real C6 / C8 (see "To check").
- [ ] **Milestone 3 — more**: air flows (once the core has an air flow unit),
      alarm reset (600 = 0x99C6) and filter reset (1051) as buttons behind
      the option, ECO/AUTO, panel 2, VOC sensors, energy counters (lifetime
      counters: never 0 nor a drop published, a way out on reset).
- [ ] **Identity**: add the unit's own IP address (registers 23-24, already in
      the block 1-34) to the fingerprint (review r1): two units of the same
      type, or another Modbus device whose register 1000 starts with nibble 0,
      would then be told apart. Mind NAT / port forwarding (refuse only on a
      positive mismatch, never on an unreadable value).
- [ ] Mode and start without a connection retry: a single-client unit slow
      to free its place right after a poll gives "not sent (closed)" (review
      r1, m6; harmless, the user presses again).

## To check on a real unit

- Which unit id the unit answers on Modbus TCP (default 1: pymodbus' default,
  what hass-komfovent actually sends; its `DEFAULT_SLAVE_ID = 254` is never
  read), whether it echoes the id asked, and the five ranges as one request
  each.
- What register 5 reads right after a mode written (immediately, or after
  a delay: then "not applied yet" is the normal first answer).
- Whether writing a mode on a unit off starts it (assumed: yes, so refused).
- That register 1 = 0 stops the unit at once (status bit "stopping" then
  fans off), and = 1 restarts it in the mode of the schedule.
- Whether the weekly schedule or the AUTO mode write register 1 (then the
  "read on twice in a row" rule would lift a kept stop at the next scheduled
  start, which is the intent).
- The C8 values: 30000 on unused temperature sensors, -32768 / -100 on the
  panel when not connected (from the C8 manual).
- Whether the unit accepts a second Modbus client (Home Assistant and Gladys
  at once).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-komfovent:0.1.0`);
  the first patch release gives 0.1.1. The manifest test checks the semver
  shape and that the four agree, never a pinned value.
- **Reference**: hass-komfovent 0.12.0 (MIT; LICENSE read: "Copyright (c)
  2025 Lenno Nagel @lnagel"), cloned read-only in `~/code/ref/lot17/komfovent`
  (commit 6e40bd1, 2026-10-27). Registers checked against the manufacturer's
  manuals shipped in its `docs/` (MODBUS_C6_2025.pdf "M-C6 / C6M_24-10",
  firmware X.X.X.18 and above; MODBUS_C8_2025.pdf "Modbus_connection_C8_24-10").
  Credited in `THIRD_PARTY_NOTICES.md` with the full license text, copied in
  the image. **Not ported**: the firmware check/upload (`firmware/`,
  `update.py`) and the `hass-komfovent/<version>` User-Agent; no request to
  komfovent.com nor to the unit's web interface.
- **SDK** 0.16.0 (latest on npm, 2026-10-27; changelog: resync of constants).
- **Sibling modules**: gladys-salda-smarty (structure, the line, Modbus
  client, guards, publisher, store) and gladys-zehnder-comfoair (units).
- **Identity (FROZEN RULE)**: no serial number in the map, so the device is
  `komfovent:unit`, one per integration, never the IP address. A light
  fingerprint: the controller type (top four bits of registers 1000-1001:
  C6, C6M, C8), learnt at the first read and kept in `/data` with the unit
  key (address and unit id). Another type read (poll or a command's fresh
  read): the status says so, the mode and the start are refused; "Test the
  connection" accepts exactly the type shown. A firmware update keeps the
  type (the version is not part of it). An unreadable value is never
  "another unit"; a command without the type read just before is refused.
  Two units of the same type are not told apart (documented).
- **One Modbus connection at a time, one request at a time** (`useLine`,
  `ModbusSession`): a poll is one session of five requests; a command aborts
  a running poll; the stop aborts anything.
- **Commands**: mode (register 5, 1-4) and start (register 1 = 1) behind the
  option; the start alone lifts a kept stop, and /data must have forgotten
  it BEFORE the first byte (save failed: refused, nothing sent; the start
  never sent: /data keeps the stop again). Refused on a fault (status bit
  11), while stopping (bit 1), on another controller type, on /data
  unreadable; the mode also on power 0, mode stand-by (0) or off (10), and
  while a stop is kept.
- **The stop (protective)**: register 1 = 0. Never held back (see docs). The
  guard is written to /data before its first byte, waiting 150 ms at most
  (never blocking). Kept with its address: `pending` (may not have landed:
  sent again by `boot()` before `gladys.connect()`), `seenOff`, `onReads`,
  `reasserts` (3 at most), `sticky` (a start or mode not confirmed when it
  was pressed). No date in /data: never lifted by the time. Lifted by a
  start pressed with the option (right before its synchronous write) or by
  the unit read on in two polls in a row after it was seen off; an unknown
  value resets that count; a value before unknown is never "changed
  elsewhere". Resent when a poll reads the unit on before it was seen off,
  or after it was seen off when sticky. A command's fresh read never moves
  the kept stop.
- **getConfig() in `connected`**: retried after 5 s, 15 s, 30 s, then every
  minute, without end, with a status; a new `connected` resets it. The stop
  pressed meanwhile goes to the address kept in `/data` (`target`).
- **Polling period**: start to start (`due` = last read + interval), never
  sooner than the interval; failures back off 30 s, 1, 2, 5 min.
- **Flow-dependent values** (hass-komfovent's choice): the efficiency and the
  air quality sensors are not published while the fan bit (900 bit 2) is off
  or the status is unknown.
- **Units**: °C; humidity %; CO2 ppm (0-5000); fan levels on `fan/percent`
  (read only); filter clogging and efficiency are `unknown` integer sensors
  "(%)" (no category for them); alarm codes and current mode are stable
  English text keys (`none`, `F9, W1`). VOC sensors are not published (the
  reference shows them in %, the core's VOC category is ppb only).
- **Configuration**: IPv4 unicast (0.x, 224-255, x.x.x.0 and x.x.x.255
  refused) or host name, optional port (502); unit id 1-255, default 1 (review
  r1, B1: the manuals give no unit id for Modbus TCP, only the RTU "protocol
  ID" of the web page; hass-komfovent sends none, so pymodbus' default 1).
  An answer carrying another unit id is accepted and logged once (one TCP
  connection reaches one controller; some servers answer with their own id);
  the transaction id, protocol, function and exact size are still checked.
  Interval 30 s – 1 h. No secret.
- **Manifest**: categories `climate`, `environment` (as the Salda Smarty);
  no `keywords` / `countries` (Komfovent is Lithuanian, sold in the EU:
  keywords "komfovent, domekt, kompakt, verso, ventilation, VMC double flux"
  and countries LT, LV, EE, FI, SE, NO, DE, PL, FR could be added once the
  store accepts them).
- **Not done**: scenes, widgets, setpoints, schedules, clock, alarm and
  filter resets, ECO/AUTO writes, panel 2, air flows, energy counters,
  Bluetooth (none).
