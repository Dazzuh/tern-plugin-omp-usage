const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const { pathToFileURL } = require("node:url");

test("pools account windows and keeps saved resets with their owners", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-remaining-"));
  const original = { execFile: childProcess.execFile, homedir: os.homedir, now: Date.now };
  const now = Date.parse("2030-01-01T00:00:00Z");
  let reports;
  childProcess.execFile = (_file, _args, _options, callback) => callback(null, JSON.stringify({ reports }));
  os.homedir = () => home;
  Date.now = () => now;
  syncBuiltinESMExports();
  try {
    const extension = await import(pathToFileURL(path.join(__dirname, "omp/extensions/usage-remaining.js")).href);
    const handlers = {};
    extension.default({ on: (name, fn) => { handlers[name] = fn; } });
    const models = [
      { provider: "anthropic", id: "opus", name: "Claude Opus" },
      { provider: "anthropic", id: "fable", name: "Claude Fable" },
    ];
    let status;
    const ctx = {
      model: models[0],
      models: { list: async () => models },
      ui: { setStatus: (_key, value) => { status = value; } },
      setInterval: () => {},
    };
    const limit = (id, window, remaining, resetHours, scope = {}) => ({
      id, scope, window: { id: window, resetsAt: now + resetHours * 3600000 },
      amount: remaining === undefined ? {} : { remainingFraction: remaining },
    });
    const credit = (clears, days, count = 1) => ({
      status: "available", clears, remainingCount: count,
      expiresAt: new Date(now + days * 86400000).toISOString(),
    });
    reports = [
      { provider: "anthropic", limits: [
        limit("a5", "5h", .95, 1), limit("a7", "7d", .02, 12),
        limit("a-tier", "7d", .8, 12, { tier: "fable" }),
        limit("a-model", "5h", .4, 2, { modelId: "opus" }),
        limit("a-day", "1d", .5, 3),
      ], resetCredits: { credits: [credit(["a7"], 3, 2), credit(["b7"], 1)] } },
      { provider: "anthropic", limits: [
        limit("b5-duplicate", "5h", .9, 2), { ...limit("b5", "5h", .62, 4), amount: { usedFraction: .38 } },
        limit("b7", "7d", .36, 2), limit("b-tier", "7d", .4, 3, { tier: "fable" }),
        limit("b-model", "5h", .8, 2, { modelId: "opus" }),
        limit("b-day", "1d", undefined, 3),
      ], resetCredits: { credits: [credit(["b7"], 4)] } },
      { provider: "anthropic", limits: [limit("unknown", "5h", undefined, 1)] },
    ];
    await handlers.session_start({}, ctx);
    const cache = JSON.parse(fs.readFileSync(path.join(home, ".omp/cache/usage-remaining.json"), "utf8"));
    assert.match(status, /5h [█░]+ 79% left \(4h\)/);
    assert.match(status, /7d [█░]+ 19% left \(12h\) \(!3 - 3d left\)/);
    assert.match(status, /1d [█░]+ 50% left/);
    assert.match(status, /Fable 7d [█░]+ 60% left/);
    assert.match(status, /Opus 5h [█░]+ 60% left/);
    assert.equal(cache.models.Opus.line, status);
    assert.match(cache.models.Fable.line, /5h [█░]+ 79% left/);
    assert.doesNotMatch(cache.models.Fable.line, /Opus 5h/);
    assert.match(cache.providers.anthropic.line, /7d [█░]+ 19% left/);
    assert.doesNotMatch(cache.providers.anthropic.line, /Opus 5h/);
    const resets = [
      { expiresAt: now + 3 * 86400000, count: 2 },
      { expiresAt: now + 4 * 86400000, count: 1 },
    ];
    assert.deepEqual(cache.models.Opus.resets, resets);
    assert.deepEqual(cache.providers.anthropic.resets, resets);

    reports = [{ provider: "anthropic", limits: [limit("scoped", "7d", .3, 6, { modelId: "opus" })],
      resetCredits: { credits: [credit(["scoped"], 2)] } }];
    await handlers.turn_end({}, ctx);
    const scopedCache = JSON.parse(fs.readFileSync(path.join(home, ".omp/cache/usage-remaining.json"), "utf8"));
    assert.deepEqual(scopedCache.models.Opus.resets, [{ expiresAt: now + 2 * 86400000, count: 1 }]);
    assert.deepEqual(scopedCache.models.Fable.resets, []);
    assert.deepEqual(scopedCache.providers.anthropic.resets, []);

    reports = [{ provider: "anthropic", limits: [
      { ...limit("single", "monthly", .129, 5), amount: { remainingFraction: .129, usedFraction: .9 } },
    ] }];
    await handlers.turn_end({}, ctx);
    assert.match(status, /mo [█░]+ 12% left \(5h\)/);
  } finally {
    childProcess.execFile = original.execFile;
    os.homedir = original.homedir;
    Date.now = original.now;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
