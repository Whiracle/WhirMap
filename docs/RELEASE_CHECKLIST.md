# Release checklist

Use this before publishing v0.1.0 on GitHub.

## Repository

- [ ] Rename repository to `whirmap` or `whiracle-whirmap`
- [ ] Add description: `Self-hosted live network map for manual topology editing and ICMP status tracking`
- [ ] Add topics: `network`, `topology`, `icmp`, `monitoring`, `fastapi`, `react`, `docker`, `self-hosted`
- [ ] Add MIT license
- [ ] Push clean source without local database files

## README

- [ ] Add 3–5 screenshots
- [ ] Add one short GIF showing: create device → add IP → ping status → child map
- [ ] Confirm Quick Start works from a clean clone
- [ ] Mention default admin credentials and password change

## Docker

- [ ] Test `docker compose up --build` on Linux
- [ ] Test `docker compose up --build` on Windows + Docker Desktop / WSL2
- [ ] Confirm data persists after container restart
- [ ] Confirm `data/app.db` is not committed

## App

- [ ] Login works
- [ ] Password change works
- [ ] Create device works
- [ ] Create child map works
- [ ] Ctrl+click opens child map
- [ ] Search opens the correct map/folder
- [ ] Notifications can be searched/deleted
- [ ] Member visibility works by group
- [ ] Ping works inside Docker with `NET_RAW`

## Release

- [ ] Create tag `v0.1.0`
- [ ] Add release notes
- [ ] Attach a clean source zip if needed
- [ ] Open initial issues for roadmap items
