# Licensing

This repository is licensed under the **Apache License, Version 2.0**. The full text is in
[`LICENSE`](LICENSE); `package.json` declares `"license": "Apache-2.0"`.

## Why this license

The plugin exists to be used inside other people's OpenClaw installations. Apache-2.0 grants that use,
including in a fleet configuration that is itself licensed differently, and it carries an explicit
patent grant. A copyleft license would add friction exactly where adoption happens — someone copying
a plugin root into their own Nix config — without protecting anything this project needs protected.

## What that means in practice

- **Using it** — installing the plugin, running it, modifying it for your own fleet — needs no
  permission and no notification.
- **Redistributing it or a modified version** must keep the license, the `NOTICE` file if one exists,
  and state what was changed. The Apache-2.0 patent grant and warranty disclaimer travel with it.
- **The name and marks** are not granted: a fork may not present itself as this project.

## Contributions

Contributions are welcome under the same license (inbound = outbound). Opening a pull request states
that you have the right to submit the work under Apache-2.0. No CLA is required.

## Distribution

The package stays `"private": true` in `package.json`: it is not published to npm or ClawHub, and the
fleet installs it from a pinned revision. Publishing is a separate decision that needs a registry
account and a final name check; the license already permits it.
