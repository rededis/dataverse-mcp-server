import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataverseBusyError, DataverseTimeoutError } from "../src/errors.js";
import type {
  HttpRequest,
  HttpResponse,
  RequestExecutor,
} from "../src/executor.js";
import {
  ConcurrencyLimitExecutor,
  RetryExecutor,
  withServiceProtection,
} from "../src/service-protection.js";

const request: HttpRequest = {
  method: "GET",
  url: "https://org.crm.dynamics.com/api/data/v9.2/accounts",
  headers: { Accept: "application/json" },
};

function response(
  status: number,
  headers: Record<string, string> = {},
  body = "{}",
): HttpResponse {
  return { status, headers: new Headers(headers), body };
}

// What Dataverse answers when a service protection limit is hit.
function throttled(retryAfter?: string): HttpResponse {
  return response(
    429,
    retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    '{"error":{"code":"0x80072322","message":"Number of requests exceeded the limit of 6000 over time window of 300 seconds."}}',
  );
}

// An inner executor that answers with the given responses, one per call.
function answering(...responses: HttpResponse[]) {
  const execute = vi.fn<RequestExecutor["execute"]>();
  for (const r of responses) execute.mockResolvedValueOnce(r);
  return { execute };
}

// An inner executor whose calls stay open until the test answers them.
function pending() {
  const open: Array<{
    answer: (r?: HttpResponse) => void;
    fail: (e: unknown) => void;
  }> = [];
  const execute = vi.fn<RequestExecutor["execute"]>(
    () =>
      new Promise((resolve, reject) => {
        open.push({ answer: (r = response(200)) => resolve(r), fail: reject });
      }),
  );
  return { execute, open };
}

// The last character of each URL sent so far, in order: "a", "b", …
function sentPaths(inner: { execute: ReturnType<typeof vi.fn> }): string[] {
  return inner.execute.mock.calls.map(([r]) =>
    (r as HttpRequest).url.slice(-1),
  );
}

function get(path: string): HttpRequest {
  return { ...request, url: `https://org.crm.dynamics.com/${path}` };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RetryExecutor", () => {
  it("waits for Retry-After on a 429, then resends and returns the answer", async () => {
    const inner = answering(throttled("5"), response(200, {}, '{"value":[]}'));
    const result = new RetryExecutor(inner).execute(request);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(inner.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(inner.execute).toHaveBeenCalledTimes(2);
    expect(inner.execute).toHaveBeenLastCalledWith(request);
    expect((await result).body).toBe('{"value":[]}');
  });

  it("fails fast when Retry-After is longer than the longest wait allowed", async () => {
    const inner = answering(throttled("45"));

    const error = await new RetryExecutor(inner, { maxRetryWaitMs: 30_000 })
      .execute(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseBusyError);
    expect((error as DataverseBusyError).reason).toBe("throttled");
    expect((error as DataverseBusyError).retryAfterMs).toBe(45_000);
    // Says when to retry, and never repeats the Dataverse error text, which
    // is not meant for users and embeds the environment's limit values.
    expect((error as Error).message).toBe(
      "Dataverse is busy: a service protection limit was reached. Retry in 45 s.",
    );
    expect(inner.execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after the allowed number of attempts, saying when to retry", async () => {
    const inner = answering(throttled("1"), throttled("1"), throttled("2"));
    const outcome = new RetryExecutor(inner, { maxAttempts: 3 })
      .execute(request)
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await outcome;

    expect(inner.execute).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(DataverseBusyError);
    expect((error as DataverseBusyError).reason).toBe("throttled");
    expect((error as DataverseBusyError).retryAfterMs).toBe(2_000);
    expect((error as Error).message).toBe(
      "Dataverse is busy: a service protection limit was reached. Retry in 2 s.",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  // RFC 9110 allows a date as well as seconds. Dataverse documents seconds,
  // but a proxy in front of it may not.
  it("understands Retry-After given as an HTTP date", async () => {
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const inner = answering(
      throttled("Thu, 01 Oct 2026 12:00:03 GMT"),
      response(200),
    );
    const result = new RetryExecutor(inner).execute(request);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(inner.execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).status).toBe(200);
  });

  // Both of Microsoft's own clients back off on their own when the header is
  // absent; the Web API sample waits 2^retries seconds, as here.
  for (const [label, header] of [
    ["missing", undefined],
    ["unreadable", "soon"],
    ["negative", "-5"],
    ["zero", "0"],
    ["not quite a date", "5 GMT"],
    ["a date already past", "Thu, 01 Oct 2026 11:59:00 GMT"],
    ["too long to be a number", "9".repeat(400)],
  ] as const) {
    it(`backs off 2 s, then 4 s, when Retry-After is ${label}`, async () => {
      vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
      const inner = answering(
        throttled(header),
        throttled(header),
        response(200),
      );
      const result = new RetryExecutor(inner).execute(request);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(inner.execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(inner.execute).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(inner.execute).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).status).toBe(200);
    });
  }

  it("returns any other status untouched, without retrying", async () => {
    const inner = answering(response(503, { "Retry-After": "1" }, "down"));

    const result = await new RetryExecutor(inner).execute(request);

    expect(result.status).toBe(503);
    expect(result.body).toBe("down");
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry a request that failed without a response", async () => {
    const failure = new DataverseTimeoutError(30_000, request);
    const inner = { execute: vi.fn().mockRejectedValue(failure) };

    await expect(new RetryExecutor(inner).execute(request)).rejects.toBe(
      failure,
    );
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });

  // "If the application continues to send such demanding requests, the
  // duration is extended" (Microsoft Learn, service protection API limits).
  it("holds back other requests until the wait Dataverse asked for is over", async () => {
    const inner = answering(throttled("5"), response(200), response(200));
    const executor = new RetryExecutor(inner);

    const first = executor.execute(request);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = executor.execute(request);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(inner.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(inner.execute).toHaveBeenCalledTimes(3);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  // Dataverse was seen to answer light requests straight after a 429 with a
  // Retry-After of minutes (#88): it turns a request away when the allowance
  // is used up at that moment, not for the whole Retry-After. So a long
  // Retry-After fails the request that got it, and holds the others back only
  // as long as a request may wait anyway.
  it("holds other requests back for no longer than a request may wait, however long Retry-After is", async () => {
    const inner = answering(throttled("300"), response(200));
    const executor = new RetryExecutor(inner, { maxRetryWaitMs: 15_000 });
    const first = await executor.execute(request).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(DataverseBusyError);
    expect((first as DataverseBusyError).retryAfterMs).toBe(300_000);

    await vi.advanceTimersByTimeAsync(5_000);
    const second = executor.execute(request);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(inner.execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect((await second).status).toBe(200);
    expect(inner.execute).toHaveBeenCalledTimes(2);
  });

  it("holds nothing back when requests may not wait at all", async () => {
    const inner = answering(throttled("300"), response(200));
    const executor = new RetryExecutor(inner, { maxRetryWaitMs: 0 });
    await executor.execute(request).catch(() => {});

    expect((await executor.execute(request)).status).toBe(200);
  });

  // Node timers can fire a millisecond early. The leftover must not be
  // counted on top of a wait that used the whole allowance.
  it("still sends when a wait of exactly the longest allowed ends a moment early", async () => {
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const inner = answering(throttled("15"), response(200));
    const result = new RetryExecutor(inner, { maxRetryWaitMs: 15_000 })
      .execute(request)
      .catch((e: unknown) => e);

    // The timer fires on schedule while the clock reads 1 ms short.
    await vi.advanceTimersByTimeAsync(14_999);
    const realNow = Date.now;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() - 1);
    await vi.advanceTimersByTimeAsync(1);
    now.mockRestore();
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({ status: 200 });
  });

  // Two requests throttled at once, with different waits: the shorter answer
  // must not promise a retry the longer pause would turn away.
  it("tells a caller to wait for the whole pause, not only for its own Retry-After", async () => {
    const inner = answering(throttled("45"), throttled("5"));
    const executor = new RetryExecutor(inner, {
      maxAttempts: 1,
      maxRetryWaitMs: 60_000,
    });

    const [long, short] = await Promise.all(
      [executor.execute(request), executor.execute(request)].map((p) =>
        p.catch((e: unknown) => e),
      ),
    );

    expect(inner.execute).toHaveBeenCalledTimes(2);
    expect((long as DataverseBusyError).retryAfterMs).toBe(45_000);
    expect((short as DataverseBusyError).retryAfterMs).toBe(45_000);
    expect((short as Error).message).toBe(
      "Dataverse is busy: a service protection limit was reached. Retry in 45 s.",
    );
  });

  it("counts the waits of one request together against the longest wait allowed", async () => {
    const inner = answering(throttled("20"), throttled("20"));
    const outcome = new RetryExecutor(inner, { maxRetryWaitMs: 30_000 })
      .execute(request)
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(20_000);
    const error = await outcome;

    expect(inner.execute).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(DataverseBusyError);
    expect((error as DataverseBusyError).retryAfterMs).toBe(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ConcurrencyLimitExecutor", () => {
  it("sends no more than the limit at once, and the rest in arrival order", async () => {
    const inner = pending();
    const executor = new ConcurrencyLimitExecutor(inner, { maxConcurrency: 2 });

    const results = ["a", "b", "c", "d"].map((p) => executor.execute(get(p)));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentPaths(inner)).toEqual(["a", "b"]);

    inner.open[1].answer(response(200, {}, "b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sentPaths(inner)).toEqual(["a", "b", "c"]);

    inner.open[0].answer(response(200, {}, "a"));
    await vi.advanceTimersByTimeAsync(0);
    inner.open[2].answer(response(200, {}, "c"));
    inner.open[3].answer(response(200, {}, "d"));
    expect((await Promise.all(results)).map((r) => r.body)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("frees the slot when the request fails without a response", async () => {
    const inner = pending();
    const executor = new ConcurrencyLimitExecutor(inner, { maxConcurrency: 1 });
    const failure = new DataverseTimeoutError(30_000, request);

    const first = executor.execute(get("a")).catch((e: unknown) => e);
    const second = executor.execute(get("b"));
    await vi.advanceTimersByTimeAsync(0);
    inner.open[0].fail(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(await first).toBe(failure);
    expect(inner.execute).toHaveBeenCalledTimes(2);
    inner.open[1].answer();
    expect((await second).status).toBe(200);
  });

  it("turns a request away when the queue is full", async () => {
    const inner = pending();
    const executor = new ConcurrencyLimitExecutor(inner, {
      maxConcurrency: 1,
      maxQueueLength: 2,
    });
    const admitted = ["a", "b", "c"].map((p) => executor.execute(get(p)));

    const error = await executor.execute(get("d")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DataverseBusyError);
    expect((error as DataverseBusyError).reason).toBe("queue-full");
    expect((error as Error).message).toBe(
      "Dataverse is busy: the queue of requests waiting to be sent is full. Retry later.",
    );

    // The ones admitted before it are unaffected.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      inner.open[i].answer();
    }
    expect((await Promise.all(admitted)).map((r) => r.status)).toEqual([
      200, 200, 200,
    ]);
    expect(inner.execute).toHaveBeenCalledTimes(3);
  });

  it("states a wait that is not a whole number of seconds exactly", async () => {
    const inner = pending();
    const executor = new ConcurrencyLimitExecutor(inner, {
      maxConcurrency: 1,
      maxQueueWaitMs: 1_500,
    });
    const first = executor.execute(get("a"));
    const second = executor.execute(get("b")).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_500);

    expect(((await second) as Error).message).toBe(
      "Dataverse is busy: the request waited 1.5 s for its turn and was not sent. Retry later.",
    );
    inner.open[0].answer();
    await first;
  });

  it("gives up on a request that waited too long for its turn, and never sends it", async () => {
    const inner = pending();
    const executor = new ConcurrencyLimitExecutor(inner, {
      maxConcurrency: 1,
      maxQueueWaitMs: 10_000,
    });
    const first = executor.execute(get("a"));
    const second = executor.execute(get("b")).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const third = executor.execute(get("c"));

    await vi.advanceTimersByTimeAsync(5_000);
    const error = await second;
    expect(error).toBeInstanceOf(DataverseBusyError);
    expect((error as DataverseBusyError).reason).toBe("queue-timeout");
    expect((error as Error).message).toBe(
      "Dataverse is busy: the request waited 10 s for its turn and was not sent. Retry later.",
    );

    // The freed slot goes to the request still waiting, not the one that left.
    inner.open[0].answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentPaths(inner)).toEqual(["a", "c"]);
    inner.open[1].answer();
    expect((await first).status).toBe(200);
    expect((await third).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withServiceProtection", () => {
  it("lets a throttled request keep its slot while it waits to be resent", async () => {
    const inner = answering(
      throttled("5"),
      response(200, {}, "a"),
      response(200, {}, "b"),
    );
    const executor = withServiceProtection(inner, { maxConcurrency: 1 });

    const first = executor.execute(get("a"));
    const second = executor.execute(get("b"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sentPaths(inner)).toEqual(["a", "a", "b"]);
    expect((await first).body).toBe("a");
    expect((await second).body).toBe("b");
  });

  it("applies the settings it is given", async () => {
    const inner = answering(throttled("1"));
    const executor = withServiceProtection(inner, { maxAttempts: 1 });

    await expect(executor.execute(request)).rejects.toBeInstanceOf(
      DataverseBusyError,
    );
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });
});
