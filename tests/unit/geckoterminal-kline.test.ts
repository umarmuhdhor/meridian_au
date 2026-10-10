import { describe, expect, it, vi } from "vitest";
import { createGeckoTerminalKlineClient } from "../../src/adapters/market/geckoterminal-kline.js";

function mkClock(startMs = 1_000_000): { now: () => Date; advance: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function mkLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mkLogger(),
  };
}

function okResponse(payload: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => payload };
}
function errResponse(status: number) {
  return { ok: false, status, statusText: "boom", json: async () => ({}) };
}

const SAMPLE = {
  data: {
    attributes: {
      ohlcv_list: [
        // newest-first per GT spec
        [1_700_060, 1.20, 1.22, 1.19, 1.21, 5000],
        [1_700_000, 1.18, 1.21, 1.17, 1.20, 4200],
        [1_699_940, 1.15, 1.19, 1.14, 1.18, 3300],
      ],
    },
  },
};

describe("geckoterminal-kline adapter", () => {
  it("reverses newest-first response to oldest-first", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse(SAMPLE));
    const client = createGeckoTerminalKlineClient({
      clock: mkClock(),
      logger: mkLogger(),
      fetchImpl,
    });
    const candles = await client.getKline("POOL", "5m", { limit: 3 });
    expect(candles).toHaveLength(3);
    // oldest-first
    expect(candles[0]!.t).toBe(1_699_940);
    expect(candles[2]!.t).toBe(1_700_060);
    expect(candles[2]!.c).toBeCloseTo(1.21);
  });

  it("caches by pool+timeframe+limit for TTL and dedups concurrent calls", async () => {
    const clock = mkClock();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));
    const client = createGeckoTerminalKlineClient({ clock, logger: mkLogger(), fetchImpl, ttlMs: 60_000 });

    // concurrent calls → 1 fetch
    const [a, b] = await Promise.all([
      client.getKline("POOL", "5m", { limit: 3 }),
      client.getKline("POOL", "5m", { limit: 3 }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);

    // within TTL → cache hit
    await client.getKline("POOL", "5m", { limit: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // force → bypass
    await client.getKline("POOL", "5m", { limit: 3, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // different timeframe → different key
    await client.getKline("POOL", "1h", { limit: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // TTL expiry → refetch
    clock.advance(61_000);
    await client.getKline("POOL", "5m", { limit: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("fails open — HTTP 429 returns [], no throw", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errResponse(429));
    const client = createGeckoTerminalKlineClient({ clock: mkClock(), logger: mkLogger(), fetchImpl });
    const candles = await client.getKline("POOL", "5m");
    expect(candles).toEqual([]);
  });

  it("fails open — network throw returns [], no throw", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const client = createGeckoTerminalKlineClient({ clock: mkClock(), logger: mkLogger(), fetchImpl });
    const candles = await client.getKline("POOL", "5m");
    expect(candles).toEqual([]);
  });

  it("fails open — malformed body returns [], no throw", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse({ unexpected: true }));
    const client = createGeckoTerminalKlineClient({ clock: mkClock(), logger: mkLogger(), fetchImpl });
    const candles = await client.getKline("POOL", "5m");
    expect(candles).toEqual([]);
  });

  it("maps timeframe → GT path + aggregate in URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));
    const client = createGeckoTerminalKlineClient({ clock: mkClock(), logger: mkLogger(), fetchImpl });
    await client.getKline("PA", "4h", { limit: 5 });
    const url = (fetchImpl.mock.calls[0]![0] ?? "") as string;
    expect(url).toContain("/networks/solana/pools/PA/ohlcv/hour");
    expect(url).toContain("aggregate=4");
    expect(url).toContain("limit=5");
    expect(url).toContain("currency=usd");
    expect(url).not.toContain("before_timestamp");
  });

  it("passes currency + before_timestamp and caches them under separate keys", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(SAMPLE));
    const client = createGeckoTerminalKlineClient({ clock: mkClock(), logger: mkLogger(), fetchImpl, ttlMs: 60_000 });
    await client.getKline("PA", "5m", { limit: 1000, currency: "token", beforeTs: 1_790_000_000.7 });
    const url = (fetchImpl.mock.calls[0]![0] ?? "") as string;
    expect(url).toContain("currency=token");
    expect(url).toContain("before_timestamp=1790000000");
    await client.getKline("PA", "5m", { limit: 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
