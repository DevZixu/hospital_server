# Prisma 8

The API uses Prisma ORM 8 with PostgreSQL. The canonical schema is [`src/prisma/contract.prisma`](src/prisma/contract.prisma); `contract.json` and `contract.d.ts` in the same directory are generated artifacts.

## Requirements

- Node.js 22.18 or newer.
- PostgreSQL 15 or newer.
- A valid `DATABASE_URL` in `.env`.

## Development

```bash
npm install
npm run dev
```

The health endpoint is `GET /health`. API routes are under `/api/v1`; authentication routes start at `/api/v1/auth`.

Run `npm run contract:emit` after editing the contract. `npm run build` emits the contract and bundles the server; `npm run typecheck` checks application and contract types.

## Existing Database

Before using database-backed routes, set `DATABASE_URL` to the real PostgreSQL database that already matches the contract. Do not use the placeholder from `.env.example` for signing or migrations.

For an existing matching database, run `npx prisma db sign` to record its current contract, then `npm run prisma8:verify`. Signing verifies the schema and writes Prisma's marker; it does not alter application tables. To create and apply a planned schema change later, use `npm run prisma8:plan -- --name <change>` and `npm run prisma8:migrate`.

No database signing or schema migration was run as part of this code migration because the workspace did not provide a verified database connection.
