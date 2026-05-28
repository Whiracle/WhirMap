# Architecture

Whiracle WhirMap uses a one-service architecture.

```text
Browser
  |
  | HTTP / WebSocket
  v
FastAPI service :8080
  |-- /api/...        Backend API
  |-- /api/ws/status  WebSocket status updates
  |-- /               Prebuilt React frontend
  |
  v
SQLite database: /data/app.db
```

## Core entities

- `users` — admin/member accounts
- `groups` — visibility groups
- `maps` — flat topology canvases
- `nodes` — devices/folders on a map
- `edges` — connections between nodes
- `device_types` — custom device labels/icons
- `node_status_events` — event-based status timeline
- `notifications` — host up/down events

## Nested maps

Nested maps are implemented as separate flat maps.

A node may point to a child map:

```text
node.child_map_id -> maps.id
```

The frontend only loads one map at a time.

## Access model

Admins see all devices.

Members see only devices where:

```text
member.groups intersects device.groups
```

This makes WhirMap suitable for simple customer/team separation.

## Ping model

The ping worker checks monitored nodes periodically and updates current status.

Status timeline is event-based:

```text
UP interval
DOWN interval
UP interval
```

It does not store one row for every ping.
