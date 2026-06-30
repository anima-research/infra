# Infra

> Formerly **soma**. Renamed to `infra`; GitHub remote is `anima-research/infra`.

Credit system (ichor) for AI bot interactions in Discord — manages costs, fair
access through regeneration, and social economy features — plus the chapter2
admin/loom command set ported to TypeScript (fork/mu/stash, config, history,
transcript, etc.). See migration status in
[../docs/infra-migration.md](../docs/infra-migration.md) and the full plan in
[INFRA_MIGRATION_PLAN.md](./INFRA_MIGRATION_PLAN.md).

## Stack
- TypeScript/Node.js
- discord.js, SQLite, dotenv

## Features
Ichor credits, bounties, leaderboard, notifications, settings, database
migrations; ported chapter2 admin & loom commands.

## Commands
```bash
npm install
npm run build
npm start
```
