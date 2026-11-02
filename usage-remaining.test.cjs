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
      { provider: "anthropic", metadata: { email: "a@example.com" }, limits: [
        limit("a5", "5h", .95, 1), limit("a7", "7d", .02, 12),
        limit("a-tier", "7d", .8, 12, { tier: "fable" }),
        limit("a-model", "5h", .4, 2, { modelId: "opus" }),
        limit("a-day", "1d", .5, 3),
      ], resetCredits: { credits: [credit(["a7"], 3, 2), credit(["b7"], 1)] } },
      { provider: "anthropic", metadata: { email: "b@example.com" }, limits: [
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
    const opusAccounts = cache.models.Opus.accounts;
    assert.deepEqual(opusAccounts.map((a) => a.label), ["a@example.com", "b@example.com"]);
    assert.match(opusAccounts[0].line, /^Claude 5h [█░]+ 95% left \(1h\) · Opus 5h [█░]+ 40% left \(2h\) · 1d [█░]+ 50% left \(3h\) · 7d [█░]+ 2% left \(12h\) \(!2 - 3d left\)/);
    assert.match(opusAccounts[1].line, /^Claude 5h [█░]+ 62% left \(4h\) · Opus 5h [█░]+ 80% left \(2h\) · 7d [█░]+ 36% left \(2h\) \(!1 - 4d left\)/);
    assert.deepEqual(opusAccounts[0].resets, [{ expiresAt: now + 3 * 86400000, count: 2 }]);
    assert.deepEqual(opusAccounts[1].resets, [{ expiresAt: now + 4 * 86400000, count: 1 }]);
    const providerAccounts = cache.providers.anthropic.accounts;
    assert.deepEqual(providerAccounts.map((a) => a.label), ["a@example.com", "b@example.com"]);
    assert.doesNotMatch(providerAccounts[0].line, /Opus/);
    assert.doesNotMatch(providerAccounts[1].line, /Opus/);
    assert.deepEqual(providerAccounts[0].resets, [{ expiresAt: now + 3 * 86400000, count: 2 }]);
    assert.deepEqual(providerAccounts[1].resets, [{ expiresAt: now + 4 * 86400000, count: 1 }]);

    reports = [{ provider: "anthropic", limits: [limit("scoped", "7d", .3, 6, { modelId: "opus" })],
      resetCredits: { credits: [credit(["scoped"], 2)] } }];
    await handlers.turn_end({}, ctx);
    const scopedCache = JSON.parse(fs.readFileSync(path.join(home, ".omp/cache/usage-remaining.json"), "utf8"));
    assert.deepEqual(scopedCache.models.Opus.resets, [{ expiresAt: now + 2 * 86400000, count: 1 }]);
    assert.deepEqual(scopedCache.models.Fable.resets, []);
    assert.equal(scopedCache.models.Opus.accounts, undefined);
    assert.equal(scopedCache.providers.anthropic.accounts, undefined);

    reports = [{ provider: "anthropic", limits: [
      { ...limit("single", "monthly", .129, 5), amount: { remainingFraction: .129, usedFraction: .9 } },
    ] }];
    await handlers.turn_end({}, ctx);
    assert.match(status, /mo [█░]+ 12% left \(5h\)/);
    reports = [
      { provider: "anthropic", metadata: { email: "same@example.com", orgName: "Org A" }, limits: [limit("x5", "5h", .5, 1)] },
      { provider: "anthropic", metadata: { email: "same@example.com", orgName: "Org B" }, limits: [limit("y5", "5h", .6, 1)] },
      { provider: "anthropic", metadata: { email: "same@example.com", orgName: "Org A" }, limits: [limit("z5", "5h", .7, 1)] },
      { provider: "anthropic", metadata: { accountId: "acct-123" }, limits: [limit("w5", "5h", .8, 1)] },
      { provider: "anthropic", limits: [limit("v5", "5h", .9, 1)] },
    ];
    await handlers.turn_end({}, ctx);
    const labelled = JSON.parse(fs.readFileSync(path.join(home, ".omp/cache/usage-remaining.json"), "utf8"));
    assert.deepEqual(labelled.providers.anthropic.accounts.map((a) => a.label), [
      "same@example.com (Org A) #1", "same@example.com (Org B)", "same@example.com (Org A) #3", "acct-123", "Account 5",
    ]);
  } finally {
    childProcess.execFile = original.execFile;
    os.homedir = original.homedir;
    Date.now = original.now;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("provider fallback is decided once, so accounts match the pooled line and resets", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-remaining-"));
  const original = { execFile: childProcess.execFile, homedir: os.homedir, now: Date.now };
  const now = Date.parse("2030-01-01T00:00:00Z");
  let reports;
  childProcess.execFile = (_file, _args, _options, callback) => callback(null, JSON.stringify({ reports }));
  os.homedir = () => home;
  Date.now = () => now;
  syncBuiltinESMExports();
  try {
    const moduleUrl = pathToFileURL(path.join(__dirname, "omp/extensions/usage-remaining.js"));
    const extension = await import(`${moduleUrl.href}?fallback-lifecycle`);
    const handlers = {};
    extension.default({ on: (name, fn) => { handlers[name] = fn; } });
    const models = [
      { provider: "anthropic", id: "opus", name: "Claude Opus" },
      { provider: "anthropic", id: "fable", name: "Claude Fable" },
    ];
    const ctx = {
      model: models[0],
      models: { list: async () => models },
      ui: { setStatus: () => {} },
      setInterval: () => {},
    };
    const limit = (id, window, remaining, resetHours, scope = {}) => ({
      id, scope, window: { id: window, resetsAt: now + resetHours * 3600000 },
      amount: { remainingFraction: remaining },
    });
    const credit = (clears, days, count = 1) => ({
      status: "available", clears, remainingCount: count,
      expiresAt: new Date(now + days * 86400000).toISOString(),
    });
    const readCache = () => JSON.parse(fs.readFileSync(path.join(home, ".omp/cache/usage-remaining.json"), "utf8"));

    // Plan 7d on A, Opus-only 5h on B: B's model window stays out of the provider.
    reports = [
      { provider: "anthropic", metadata: { email: "a@example.com" }, limits: [limit("a7", "7d", .5, 12)],
        resetCredits: { credits: [credit(["a7"], 2)] } },
      { provider: "anthropic", metadata: { email: "b@example.com" },
        limits: [limit("b-model", "5h", .8, 2, { modelId: "opus" })] },
    ];
    await handlers.session_start({}, ctx);
    let cache = readCache();
    assert.match(cache.providers.anthropic.line, /^Claude 7d [█░]+ 50% left/);
    assert.doesNotMatch(cache.providers.anthropic.line, /Opus/);
    assert.deepEqual(cache.providers.anthropic.accounts.map((a) => a.label), ["a@example.com"]);
    assert.deepEqual(cache.providers.anthropic.accounts[0].resets, [{ expiresAt: now + 2 * 86400000, count: 1 }]);
    // The active model keeps both its plan window and its own model window.
    assert.deepEqual(cache.models.Opus.accounts.map((a) => a.label), ["a@example.com", "b@example.com"]);
    assert.match(cache.models.Opus.accounts[0].line, /^Claude 7d [█░]+ 50% left/);
    assert.match(cache.models.Opus.accounts[1].line, /^Claude Opus 5h [█░]+ 80% left/);
    assert.deepEqual(cache.models.Opus.accounts[0].resets, [{ expiresAt: now + 2 * 86400000, count: 1 }]);

    // Every limit is scoped to Opus: the provider falls back to all windows for every account.
    reports = [
      { provider: "anthropic", metadata: { email: "c@example.com" }, limits: [limit("c-opus", "7d", .7, 12, { modelId: "opus" })],
        resetCredits: { credits: [credit(["c-opus"], 3)] } },
      { provider: "anthropic", metadata: { email: "d@example.com" },
        limits: [limit("d-opus", "5h", .6, 2, { modelId: "opus" })] },
    ];
    await handlers.turn_end({}, ctx);
    cache = readCache();
    assert.match(cache.providers.anthropic.line, /^Claude Opus 5h [█░]+ 60% left/);
    assert.match(cache.providers.anthropic.line, /Opus 7d [█░]+ 70% left/);
    assert.deepEqual(cache.providers.anthropic.accounts.map((a) => a.label), ["c@example.com", "d@example.com"]);
    assert.match(cache.providers.anthropic.accounts[0].line, /Opus 7d [█░]+ 70% left/);
    assert.match(cache.providers.anthropic.accounts[1].line, /Opus 5h [█░]+ 60% left/);
    assert.deepEqual(cache.providers.anthropic.accounts[0].resets, [{ expiresAt: now + 3 * 86400000, count: 1 }]);
    assert.deepEqual(cache.providers.anthropic.accounts[1].resets, []);
    // The active model still gets its own scoped windows and resets.
    assert.deepEqual(cache.models.Opus.accounts[0].resets, [{ expiresAt: now + 3 * 86400000, count: 1 }]);
  } finally {
    childProcess.execFile = original.execFile;
    os.homedir = original.homedir;
    Date.now = original.now;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
