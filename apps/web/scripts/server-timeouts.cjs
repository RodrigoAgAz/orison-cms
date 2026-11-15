/**
 * Preloaded into `next start` (see the "start" script in apps/web/package.json):
 *   node --require ./scripts/server-timeouts.cjs ../../node_modules/next/dist/bin/next start
 *
 * Node's HTTP server aborts any request whose body has not fully arrived within
 * `server.requestTimeout` (300 s by default) with a 408. `next start` keeps that default and has no
 * option for it, which cuts off phone uploads of a few hundred MB over mobile data. This raises the
 * limit on the servers Next creates and changes nothing else: Next still creates and owns the server
 * (middleware, hostname/port from the environment, keep-alive and shutdown handling are untouched).
 *
 * REQUEST_TIMEOUT_SECONDS overrides the limit (default 1800 = 30 minutes; 0 disables it).
 * A reverse proxy in front of the app has its own body/idle timeouts, which must also allow this.
 */
"use strict";

const http = require("node:http");
const https = require("node:https");

const DEFAULT_SECONDS = 30 * 60;

function requestTimeoutMs() {
  const raw = process.env.REQUEST_TIMEOUT_SECONDS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_SECONDS * 1000;
  }
  return Math.round(seconds * 1000);
}

const timeoutMs = requestTimeoutMs();

function wrap(mod) {
  const original = mod.createServer;
  mod.createServer = function createServerWithRequestTimeout(...args) {
    const server = original.apply(this, args);
    // Read on every connection check, so setting it after construction takes effect.
    server.requestTimeout = timeoutMs;
    return server;
  };
}

wrap(http);
wrap(https);

module.exports = { requestTimeoutMs };
