# Security Policy

## Supported versions

Whiracle WhirMap is currently in early MVP stage. Security fixes target the latest public version.

## Reporting a vulnerability

Please report security issues privately by opening a private advisory on GitHub, or by contacting the project maintainer directly.

Do not publish exploit details publicly before a fix is available.

## Deployment warning

This project is not yet hardened for direct public internet exposure.

Recommended deployment:

- run inside a trusted network, VPN, or private management subnet
- use HTTPS behind a reverse proxy
- change the default admin password immediately
- keep backups of `data/app.db`
- restrict access with firewall rules where possible
