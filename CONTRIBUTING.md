# Contributing to Whiracle WhirMap

Thanks for your interest in contributing.

## Current project stage

Whiracle WhirMap is in an early MVP stage. The current priority is stability, clarity, and keeping the product simple.

## Good first contributions

- bug reports with clear reproduction steps
- UI polish
- documentation improvements
- Docker / Linux deployment fixes
- performance testing with large maps
- small backend fixes

## Development setup

Run with Docker:

```bash
cp .env.example .env
docker compose up --build
```

Frontend source is in `frontend/src`. The app currently serves the prebuilt frontend from `frontend/dist` for simple one-service deployment.

After frontend changes:

```bash
cd frontend
npm install
npm run build
```

Then rebuild Docker:

```bash
docker compose up --build
```

## Pull request guidelines

Please keep PRs focused and small.

Before opening a PR:

- run the app locally
- check that Docker startup still works
- avoid adding large new features without discussion
- update README/docs when behavior changes

## Product direction

WhirMap should stay simple:

- manual topology first
- ICMP status only for now
- clean UX over feature overload
- no automatic network discovery in the MVP
- no heavy monitoring-suite behavior in the MVP
