# Whiracle WhirMap

**Self-hosted live network map for manual topology editing and ICMP status tracking.**

Draw your network. Group your devices. Ping them. See what is down.

Whiracle WhirMap is a simple visual network operations board. It is designed for teams that want a clean, manual network map with live ICMP status, nested maps, access groups, search, notifications, and status timelines — without deploying a full monitoring suite.

> Current status: early open-source release.

## Features

- Manual network topology editor
- Nested maps / folders / child nodes
- ICMP-based device status
- Event-based **Status timeline**: records state changes, not every ping
- Notifications when devices go `UP -> DOWN` or `DOWN -> UP`
- Global search by label, IP / hostname, type, group, and map path
- Users and groups
- Admin and member roles
- Group-based visibility: members see only devices in their groups
- Custom device types with icons
- One-service Docker deployment
- SQLite storage by default
- Prebuilt frontend included for simple Docker startup

## Screenshots

<img width="1127" height="652" alt="image" src="https://github.com/user-attachments/assets/ff084052-0f06-4846-98a7-483247057d03" />
<img width="770" height="525" alt="image" src="https://github.com/user-attachments/assets/342169c3-3c53-4471-95f5-45e9525c9ee5" />
<img width="1127" height="651" alt="image" src="https://github.com/user-attachments/assets/a8285df1-3e96-42d0-9491-d64741013930" />
<img width="1127" height="653" alt="image" src="https://github.com/user-attachments/assets/1f60b0bb-ea76-4790-92ab-6b6a79c0d6e7" />
<img width="1127" height="653" alt="image" src="https://github.com/user-attachments/assets/a7a351bb-fe91-4d38-8cd2-3fdc160efe7b" />

## Quick start

Requirements:

- Docker
- Docker Compose

Clone and run:

```bash
git clone https://github.com/Whiracle/whirmap.git
cd whirmap
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:8080
```

Default login:

```text
username: admin
password: admin123
```

Change the admin password immediately after first login from **Account**.

## Configuration

Environment variables are defined in `.env` and used by `docker-compose.yml`.

```env
APP_PORT=8080
DB_PATH=/data/app.db
PING_INTERVAL_SECONDS=5
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=admin123
```

Important notes:

- `DEFAULT_ADMIN_USERNAME` and `DEFAULT_ADMIN_PASSWORD` are used only when the first admin user is created.
- If `data/app.db` already exists, changing these values will not reset the existing admin password.
- To start from a clean database, stop the app and delete `data/app.db`.

## Data storage

All application data is stored in SQLite by default:

```text
data/app.db
```

This includes:

- users
- groups
- maps
- devices
- edges
- device types
- current statuses
- status timeline events
- notifications

Backup:

```bash
cp data/app.db data/app.backup.db
```

Reset local data:

```bash
docker compose down
rm -f data/app.db
docker compose up --build
```

On Windows PowerShell:

```powershell
docker compose down
Remove-Item .\data\app.db
docker compose up --build
```

## ICMP and Docker

The container needs permission to send ICMP packets. Docker Compose grants this with:

```yaml
cap_add:
  - NET_RAW
```

If ping works from the host but not from the container, check firewall rules, Docker networking, and whether ICMP is allowed to the target device.

## User roles

### Admin

Admins can:

- edit maps
- create, edit, and delete devices
- create child maps
- create users
- create groups
- create device types
- assign users and devices to groups
- view all devices
- manage notifications

### Member

Members can:

- view maps
- view devices assigned to their groups
- view status timelines
- view notifications for visible devices

Members cannot edit topology or manage users/groups/device types.

## Nested maps

A device can have a child map.

You can open a child map in two ways:

- from the device modal
- by holding `Ctrl` and clicking a node that has a child map

Search results open the map/folder where the matching device is located.

## Local development

The production-style Docker flow serves the prebuilt React frontend from FastAPI.

For frontend development:

```bash
cd frontend
npm install
npm run build
```

For backend development:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
```

## Project structure

```text
backend/          FastAPI backend, database models, auth, ping worker
frontend/src/     React source code
frontend/dist/    Prebuilt frontend served by FastAPI
data/             Local SQLite database volume
Dockerfile        One-service runtime image
docker-compose.yml
```

## Security notes

This is an early MVP. Before exposing it outside a trusted network:

- change the default admin password
- use HTTPS behind a reverse proxy
- set a strong `DEFAULT_ADMIN_PASSWORD` before first start
- restrict access with firewall/VPN where possible
- back up `data/app.db`

Do not expose this directly to the public internet without additional hardening.

## Roadmap

Possible future improvements:

- JSON export/import
- PostgreSQL option
- fping-based high-scale ping worker
- map performance tuning for large deployments
- audit log
- dark mode
- better backup/restore tooling

## License

MIT License. See [LICENSE](LICENSE).
