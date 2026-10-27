# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## hass-komfovent

<https://github.com/lnagel/hass-komfovent> (Home Assistant custom integration
for the Komfovent C6, C6M and C8 controllers, version 0.12.0, commit 6e40bd1
of 2026-10-27), by Lenno Nagel. MIT License; full text below.

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/app.js`: the
Modbus TCP map of the controllers as hass-komfovent reads and writes it, and
as Komfovent's own manuals describe it (C6 / C6M controller Modbus, 24-10; C8
Modbus connection, 24-10): register number N is protocol address N - 1; the
read ranges (holding registers 1 to 34, 200 to 214, 600 to 610, 900 to 955,
1000 to 1001); register 1 (on/off), 3 (ECO), 4 (AUTO), 5 (current mode, 0 to
10; written 1 to 4: away, normal, intensive, boost); 213 and 214 (air quality
sensor types); 600 to 610 (active alarms and their codes, F/W notation); 900
(status bits); 902 to 904 (supply, extract and outdoor temperatures in tenths
of a degree, signed); 910 and 911 (fan levels in tenths of a percent); 917
(filter clogging); 924 (heat exchanger efficiency); 946, 947 and 954 (panel 1
temperature, humidity, connected panels); 952 and 953 (air quality sensors);
1000 and 1001 (controller type and firmware version bit fields); the choice
to leave the efficiency and the extract air sensors unknown while the fans
are stopped.

Changed: the Modbus TCP client (MBAP framing, one connection, one request at
a time, bounded answers) is the integration's own, without pymodbus; values
out of the manuals' ranges and the C8 sentinels (30000, -32768, -100) are
unknown, never published; the mode is written only on a running unit; the
air flows, setpoints, schedules, ECO/AUTO switches, alarm and filter resets,
the clock setting and the exponential smoothing are not used. Not ported at
all: the firmware check and upload of hass-komfovent (its requests to
komfovent.com and to the unit's web interface, and its User-Agent).

```
MIT License

Copyright (c) 2025 Lenno Nagel @lnagel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
