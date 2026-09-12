/**
 * Loads `.env` into `process.env` for local runs, so `node dist/entrypoints/daemon.js`
 * behaves the same as the Docker deployment without needing `--env-file=.env`.
 *
 * Imported for its side effect only, and it must be the FIRST import of any entrypoint:
 * ESM evaluates every imported module before the importing module's own statements, so
 * calling `config()` inline in daemon.ts would run after the other adapters have loaded.
 *
 * A no-op in production:
 *  - `.env` / `.env.*` are in `.dockerignore`, so the image never carries one.
 *  - dotenv does not override an already-set variable, so `docker-compose.yml` env wins.
 */
import { config } from "dotenv";

config({ quiet: true });
