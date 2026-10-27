# Komfovent for Gladys

Shows a **Komfovent** heat recovery ventilation unit with a **C6, C6M or C8**
controller (Domekt, Kompakt, Verso…) in Gladys, through its **Modbus TCP**
interface on your local network, without any cloud or account. Unofficial
integration, **not affiliated with Komfovent**. **Never tested with a real
device**: it reads and writes the registers described in Komfovent's Modbus
manuals (C6 / C6M and C8, edition 24-10) as the open-source hass-komfovent
integration (Home Assistant) uses them; please report what you see.

## Before you start

- The unit must be on your network (RJ-45 socket of the controller),
  reachable from Gladys on **port 502**. Give it a fixed IP address in your
  router (factory address: 192.168.0.60).
- Modbus TCP has **no password**: keep the unit on a trusted network.
- The Modbus unit id is 254 by default (hass-komfovent's value); change it
  only if your unit answers another one.

## Installation

1. Install the integration from the Gladys store.
2. Enter the **IP address of the unit** (port 502 unless you add one); save.
3. Open the **Discovery** tab and add the unit.

## What you get

One device, **Komfovent ventilation**, with:

| Feature                                      | Notes                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Supply, extract and outdoor air temperatures | °C                                                                                                                           |
| Panel temperature and humidity               | only when panel 1 is connected                                                                                               |
| Supply and extract fan levels                | %                                                                                                                            |
| Filter clogging, heat exchanger efficiency   | %; the efficiency is not published while the fans are stopped                                                                |
| CO2 and extract humidity (sensors 1 and 2)   | by the sensor type set on the unit; not published while the fans are stopped                                                 |
| Ventilation mode                             | list: away, normal, intensive, boost                                                                                         |
| Current mode                                 | text: `standby`, `away`, `normal`, `intensive`, `boost`, `kitchen`, `fireplace`, `override`, `holiday`, `air-quality`, `off` |
| Unit on, fans running, ECO, AUTO             | read only, 1 = yes                                                                                                           |
| Fault (F alarm), warning (W alarm)           | read only, 1 = active                                                                                                        |
| Active alarms, alarm codes                   | a count; text `none` or `F9, W1` (the manual's notation)                                                                     |
| Start the unit / Stop the unit               | buttons                                                                                                                      |

A value outside the ranges of the manual (sensor missing, panel not
connected, the C8's "not used" values) is never published: Gladys keeps the
last known value. The air flows (m³/h, l/s or % by controller and setting)
are not published.

The unit is read every 60 s (30 s to 1 h), in five requests over one
connection, closed after. The test button, a Discovery scan, a reconnection
of Gladys or a restart of the integration never read it sooner than the
interval. Reads outside the interval:

- every command reads the unit right before writing, then reads the value
  written back;
- "Stop the unit" and its resends;
- 5 s then 20 s after a command not confirmed, or after a stop that follows
  a start or a mode not confirmed;
- a new address or unit id saved is read at once.

The alarms, the sensor types and the firmware version are read last: when
they do not answer, the values read before are published anyway, and the
failing block is tried again once an hour.

## Commands

The mode and "Start the unit" are refused unless **Allow the commands** is
on (off by default). No switch: a voice assistant's "turn everything off"
never reaches the ventilation.

- Every command reads the unit right before writing (on/off, mode, status,
  controller type), writes nothing when the value already is right, and is
  confirmed only when the unit returns the echo of the write and then reads
  the value asked. A read back still showing the state before answers "not
  applied yet"; a command that may have reached the unit without being
  confirmed answers "sent, without confirmation": check the unit a few
  seconds later. A Modbus exception 1, 2 or 3 answers "refused" (not
  applied); any other exception answers "sent, without confirmation". A
  command that cannot be written within 3.5 s is refused and nothing is sent.
- Also refused: on a **fault** (F alarm), while the unit is **stopping**,
  when the **controller type** read differs from the one learnt (see below),
  when **/data** cannot be read or written.
- The **mode** is refused on a unit that is **off or in stand-by** (it would
  start it) and while a **stop sent from Gladys is kept**: press "Start the
  unit" first.

### Stop the unit

"Stop the unit" writes 0 in the on/off register. It does **not** depend on
the option, on another command (a command not written yet is cancelled), on
a read in progress or stuck (it is interrupted), on a failed read or a wait
between two tries, on the controller type, on /data, nor on the
configuration not read again from Gladys yet (it then goes to the address
kept in /data). It is tried again for 3.5 s after the press.

It can fail in these cases only, and the answer says so:

- no address known (never configured): "not sent";
- the unit cannot be reached within 3.5 s: "not sent" (or "not sent yet"
  while it still tries);
- the unit answers a Modbus exception 1, 2 or 3: "refused";
- no answer, a wrong echo, or the unit read back on: "sent, without
  confirmation".

The stop is then **kept** (in /data, with the address): it is never lifted
by the time, only by "Start the unit" pressed (with the option), or when the
unit is read on **twice in a row** after it was seen off (started from its
panel). While it is kept, a read that finds the unit on before it was seen
off (or after a start that could still land) sends the stop again, three
times at most; the status says so. A stop that may not have landed when the
integration stopped is sent again when it restarts, even before the
configuration is read again.

## Identity of the unit

Komfovent's Modbus gives no serial number. The device is therefore tied to
the unit of the configuration, never to its IP address (a new address keeps
the device and its history). The **controller type** (C6, C6M, C8) is learnt
at the first read; when it changes, another device may answer at the
address: the mode and the start are refused until "Test the connection"
accepts it (the stop does not depend on it). Two units of the same type are not told
apart.

## What the integration does not do

It never updates the firmware, never sets the clock, the setpoints or the
schedules, never resets the alarms nor the filter counter.
