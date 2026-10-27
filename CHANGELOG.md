# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Komfovent heat recovery ventilation (C6, C6M, C8 controllers) over local
  Modbus TCP: supply, extract, outdoor and panel temperatures, panel
  humidity, fan levels, current mode, on/off, fans running, ECO, AUTO,
  filter clogging, heat exchanger efficiency, CO2 and humidity sensors,
  fault, warning, active alarms and their codes.
- Commands behind "Allow the commands" (off by default): the mode (away,
  normal, intensive, boost) and "Start the unit"; "Stop the unit" never
  depends on the option, is kept until a start, and is sent again after a
  restart when it may not have landed (the guide lists when it can fail).
- "Test the connection" button, docs in English and French, cover image.
