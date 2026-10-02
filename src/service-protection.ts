// Dataverse service protection limits (#74, ADR-0001 §10): what the client
// does when Dataverse answers 429, and how it avoids sending too much at once.
// Nothing here counts requests or knows the limit values, which vary between
// environments; it reacts to 429 and Retry-After.
//
// Dataverse counts its limits per web server, and without an affinity cookie
// (Node's fetch keeps none, as Microsoft recommends for parallel clients)
// requests spread over several. What follows deliberately ignores that and
// treats a 429 as true of the whole environment: a retry may reach a server
// that was never busy, which costs a wait, not correctness.

import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_QUEUE_LENGTH,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  DEFAULT_MAX_RETRY_WAIT_MS,
} from "./config.js";
import { DataverseBusyError } from "./errors.js";
import type { HttpRequest, HttpResponse, RequestExecutor } from "./executor.js";

/**
 * The longest a 429 holds back requests other than the one it answered: one
 * window of the limits Dataverse measures over time. After that a request
 * goes out and asks again, so one absurd Retry-After cannot stop the server
 * until it is restarted.
 */
const MAX_PAUSE_MS = 300_000;

export interface RetryOptions {
  /**
   * The longest one request waits on throttling, all its waits together. A
   * wait that would go past it fails the call instead, saying when to retry.
   */
  maxRetryWaitMs?: number;
  /** How many times one request may be sent, the first try included. */
  maxAttempts?: number;
}

/**
 * Resends a request Dataverse throttled, after the wait Dataverse asks for.
 *
 * One instance stands for one application user, which is what Dataverse
 * throttles: a 429 on any request holds back every request through this
 * instance until the wait is over (MAX_PAUSE_MS at most), because sending
 * more while throttled makes Dataverse extend it.
 *
 * Every 429 is retried: whatever error code its body carries, as in
 * Microsoft's Web API sample, and whatever the method. Retrying writes
 * follows Microsoft's ServiceClient, which resends a throttled create; no
 * source promises that a request answered with 429 was not run.
 *
 * The request is resent as built, token included; see MAX_WAIT_MS in
 * config.ts for why that token is still valid.
 */
export class RetryExecutor implements RequestExecutor {
  private maxRetryWaitMs: number;
  private maxAttempts: number;
  /** No request is sent before this moment (epoch ms). */
  private pausedUntil = 0;

  constructor(
    private inner: RequestExecutor,
    options: RetryOptions = {},
  ) {
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_MAX_RETRY_WAIT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async execute(request: HttpRequest): Promise<HttpResponse> {
    let waitedMs = 0;
    for (let attempt = 1; ; attempt++) {
      // A loop, because another request may extend the pause meanwhile.
      for (;;) {
        const pauseMs = this.pausedUntil - Date.now();
        if (pauseMs <= 0) break;
        if (waitedMs + pauseMs > this.maxRetryWaitMs) {
          throw throttledError(pauseMs);
        }
        // Time that passed, not time asked for: a timer can fire a moment
        // early, and the remainder must still fit the allowance.
        const before = Date.now();
        await sleep(pauseMs);
        waitedMs += Date.now() - before;
      }

      const response = await this.inner.execute(request);
      if (response.status !== 429) return response;

      const retryMs =
        parseRetryAfter(response.headers.get("Retry-After")) ??
        backoffMs(attempt);
      this.pausedUntil = Math.max(
        this.pausedUntil,
        Date.now() + Math.min(retryMs, MAX_PAUSE_MS),
      );
      if (
        attempt >= this.maxAttempts ||
        waitedMs + retryMs > this.maxRetryWaitMs
      ) {
        // Another 429 may have set a longer pause than this one asks for;
        // a retry before that pause ends would be turned away.
        throw throttledError(Math.max(retryMs, this.pausedUntil - Date.now()));
      }
    }
  }
}

export interface ConcurrencyLimitOptions {
  /** How many requests may be in flight at once. */
  maxConcurrency?: number;
  /** How many requests may wait for a slot; one more is turned away. */
  maxQueueLength?: number;
  /** How long a request waits for a slot before it is turned away. */
  maxQueueWaitMs?: number;
}

/**
 * Keeps the number of requests in flight under a limit; the rest wait their
 * turn in arrival order.
 *
 * This only makes a 429 less likely. Dataverse also limits combined execution
 * time, which a few slow requests can exceed at any concurrency, so
 * RetryExecutor belongs inside this one: a request then keeps its place while
 * it waits to be resent.
 */
export class ConcurrencyLimitExecutor implements RequestExecutor {
  private maxConcurrency: number;
  private maxQueueLength: number;
  private maxQueueWaitMs: number;
  private inFlight = 0;
  /** Each entry hands a slot to the request that queued it. */
  private waiting: Array<() => void> = [];

  constructor(
    private inner: RequestExecutor,
    options: ConcurrencyLimitOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
  }

  async execute(request: HttpRequest): Promise<HttpResponse> {
    await this.takeSlot();
    try {
      return await this.inner.execute(request);
    } finally {
      this.releaseSlot();
    }
  }

  private async takeSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight++;
      return;
    }
    if (this.waiting.length >= this.maxQueueLength) {
      throw new DataverseBusyError(
        "queue-full",
        "Dataverse is busy: the queue of requests waiting to be sent is full. Retry later.",
      );
    }
    return new Promise((resolve, reject) => {
      const handOver = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(handOver), 1);
        reject(
          new DataverseBusyError(
            "queue-timeout",
            `Dataverse is busy: the request waited ${this.maxQueueWaitMs / 1000} s for its turn and was not sent. Retry later.`,
          ),
        );
      }, this.maxQueueWaitMs);
      this.waiting.push(handOver);
    });
  }

  private releaseSlot(): void {
    // The slot passes straight to the next in line, so inFlight is unchanged.
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }
}

export type ServiceProtectionSettings = RetryOptions & ConcurrencyLimitOptions;

/**
 * Both protections around an executor, in the order that works: the limit
 * outside, retries inside.
 */
export function withServiceProtection(
  inner: RequestExecutor,
  settings: ServiceProtectionSettings = {},
): RequestExecutor {
  return new ConcurrencyLimitExecutor(
    new RetryExecutor(inner, settings),
    settings,
  );
}

// IMF-fixdate, the one date form RFC 9110 lets a sender generate.
const HTTP_DATE =
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The wait a Retry-After header asks for, or undefined when it names none:
 * missing, unreadable, zero, already past or too large to be a number.
 * Dataverse documents whole seconds; RFC 9110 also allows a date.
 */
function parseRetryAfter(header: string | null): number | undefined {
  const value = header?.trim() ?? "";
  let ms: number;
  if (/^\d+$/.test(value)) ms = Number(value) * 1000;
  // Date.parse alone is too generous: it reads "-5" as a year.
  else if (HTTP_DATE.test(value)) ms = Date.parse(value) - Date.now();
  else return undefined;
  // Enough digits make Number() return Infinity.
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The wait before the next send when Dataverse named none: 2 s, 4 s, 8 s, …
 * as in Microsoft's Web API sample.
 */
function backoffMs(attempt: number): number {
  return 2 ** attempt * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throttledError(waitMs: number): DataverseBusyError {
  return new DataverseBusyError(
    "throttled",
    `Dataverse is busy: a service protection limit was reached. Retry in ${Math.ceil(waitMs / 1000)} s.`,
    waitMs,
  );
}
