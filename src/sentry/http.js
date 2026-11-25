// -----------------------------------------------------------------------------
// The only network access of the integration: one GET on node:https (node:http
// only for a self-hosted Sentry on a private address, see src/config.js). A
// deadline for the whole exchange, a size cap on the body (checked on the
// announced length, then on every chunk), no redirect followed (the token
// would go along), the certificate always checked, no compression asked.
// Resolves { status, headers, body } for any status; rejects a SentryError for
// the transport failures. Messages carry a system code only: never the URL
// (no secret is in it, but nothing is gained) nor the token.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { USER_AGENT } from '../constants.js';

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no connection, TLS refused
  TIMEOUT: 'timeout', // no complete answer in time
  TOO_LARGE: 'too_large', // answer above the size cap
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  REDIRECT: 'redirect', // a 3xx: never followed
  BAD_ANSWER: 'bad_answer', // not the JSON documented
  CLOSED: 'closed', // the client was replaced or stopped
  LIMITED: 'limited', // Sentry's window spent: the rest of the round waits
});

export class SentryError extends Error {
  constructor(code, message, { status, retryAfterMs, route } = {}) {
    super(message);
    this.name = 'SentryError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (route !== undefined) this.route = route;
  }
}

function transportError(err) {
  const code = String(err?.code ?? '')
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 40);
  return new SentryError(CODES.UNREACHABLE, code || 'Connection failed');
}

/**
 * @param {string} url absolute URL
 * @param {object} options
 * @param {string} options.token the auth token (Authorization header only)
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {AbortSignal} [options.signal] aborts the exchange (the client closed)
 */
export function httpGet(url, { token, timeout, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const onAbort = () => finish(new SentryError(CODES.CLOSED, 'Client closed'));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(new SentryError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`)),
      timeout,
    );
    try {
      const target = new URL(url);
      const lib = target.protocol === 'https:' ? https : http;
      req = lib.request(
        {
          method: 'GET',
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'user-agent': USER_AGENT,
          },
          rejectUnauthorized: true,
        },
        (res) => {
          const announced = Number(res.headers['content-length']);
          if (Number.isFinite(announced) && announced > maxBytes) {
            finish(new SentryError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              finish(new SentryError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => finish(transportError(err)));
          res.on('aborted', () => finish(transportError({ code: 'ECONNRESET' })));
        },
      );
      req.on('error', (err) => finish(transportError(err)));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      req.end();
    } catch (err) {
      finish(transportError(err));
    }
  });
}
