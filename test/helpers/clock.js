// -----------------------------------------------------------------------------
// Test clocks. `fakeClock`: nothing moves by itself, `advance(ms)` moves both
// clocks and fires the due timers in order, awaiting each (200 real ms at most),
// a few event-loop turns between two. Each read of the monotonic clock moves it 1 µs: a
// decision that reads it twice sees it move. `realClock`: the real clock sped
// up (timers divided by `speed`, clocks in simulated ms).
// -----------------------------------------------------------------------------

const turn = () => new Promise((resolve) => setImmediate(resolve));

export function fakeClock({ wall = Date.parse('2026-11-25T20:00:00Z'), mono = 1_000_000 } = {}) {
  let wallNow = wall;
  let monoNow = mono;
  let nextId = 1;
  const pending = new Map();
  const clock = {
    pending,
    now: () => wallNow,
    monotonic: () => {
      monoNow += 0.001;
      return monoNow;
    },
    /** Moves the wall clock only (a clock set back or forward). */
    setWall: (ms) => {
      wallNow = ms;
    },
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { id, fn, at: monoNow + Math.max(0, ms) });
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    /** The delays (ms from now) of the timers waiting, sorted. */
    delays: () =>
      [...pending.values()].map((t) => Math.round(t.at - monoNow)).sort((a, b) => a - b),
    async settle() {
      for (let i = 0; i < 20; i += 1) await turn();
    },
    async advance(ms) {
      const end = monoNow + ms;
      for (;;) {
        await clock.settle();
        const due = [...pending.values()]
          .filter((t) => t.at <= Math.max(end, monoNow))
          .sort((a, b) => a.at - b.at || a.id - b.id);
        if (due.length === 0) break;
        const [t] = due;
        pending.delete(t.id);
        wallNow += Math.max(0, t.at - monoNow);
        monoNow = Math.max(monoNow, t.at);
        // Awaited, but never more than 200 real ms: a hung task (a server
        // that never answers) does not stop the clock.
        let wait;
        await Promise.race([t.fn(), new Promise((resolve) => (wait = setTimeout(resolve, 200)))]);
        clearTimeout(wait);
      }
      wallNow += Math.max(0, end - monoNow);
      monoNow = Math.max(monoNow, end);
      await clock.settle();
    },
  };
  return clock;
}

export function realClock({ speed = 100 } = {}) {
  const start = performance.now();
  const wallStart = Date.now();
  const handles = new Set();
  return {
    now: () => wallStart + (performance.now() - start) * speed,
    monotonic: () => (performance.now() - start) * speed,
    timers: {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(() => {
          handles.delete(handle);
          fn();
        }, ms / speed);
        handles.add(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        handles.delete(handle);
        clearTimeout(handle);
      },
    },
    close: () => {
      for (const handle of handles) clearTimeout(handle);
      handles.clear();
    },
  };
}
