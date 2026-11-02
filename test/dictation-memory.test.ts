import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DictationMemory, tidy } from "../src/server/dictation-memory.ts";
const LEARN_MODULE: string = "../web/dictation-learn.js";
const { learnFrom, plausibleFix } = await import(LEARN_MODULE);

async function memory() {
    const dir = await mkdtemp(join(tmpdir(), "voice-memory-"));

    return { dir, memory: new DictationMemory(dir), dispose: () => rm(dir, { recursive: true }) };
}

test("tidy keeps short plain one-line text only", () => {
    assert.equal(tidy("  Pi   Pocket "), "Pi Pocket");
    assert.equal(tidy("a\nb`c<d>"), "a b c d");
    assert.equal(tidy("x".repeat(61)), undefined);
    assert.equal(tidy(""), undefined);
    assert.equal(tidy(5), undefined);
});

test("corrections are remembered, counted, private, and survive a restart", async () => {
    const m = await memory();

    try {
        assert.equal(await m.memory.promptText(), "");
        await m.memory.learn([{ heard: "Pie Pocket", wanted: "Pi Pocket" }], []);
        await m.memory.learn([{ heard: "pie pocket", wanted: "Pi Pocket" }], []);
        await m.memory.learn(
            [{ heard: "same", wanted: "same" }, { heard: "", wanted: "x" }, null],
            [],
        );

        const again = new DictationMemory(m.dir);
        const listed = await again.list();

        assert.deepEqual(
            listed.corrections.map((c) => [c.heard, c.wanted, c.count]),
            [["pie pocket", "Pi Pocket", 2]],
        );
        assert.match(await again.promptText(), /- pie pocket → Pi Pocket/);
        assert.equal((await stat(join(m.dir, "dictation-learned.json"))).mode & 0o777, 0o600);
        // A different fix for the same words replaces the old one and starts counting again.
        await again.learn([{ heard: "pie pocket", wanted: "PiPocket" }], []);
        assert.equal((await again.list()).corrections[0]!.count, 1);
        assert.equal(await again.remove("correction", "pie pocket"), true);
        assert.equal(await again.remove("correction", "pie pocket"), false);
        assert.equal(await again.remove("nonsense", "x"), false);
    } finally {
        await m.dispose();
    }
});

test("a term is only offered to the model once it has been used a few times", async () => {
    const m = await memory();

    try {
        await m.memory.learn([], ["HareDream", "HareDream", "Once"]);
        assert.equal(await m.memory.promptText(), "");
        await m.memory.learn([], ["HareDream"]);
        assert.match(await m.memory.promptText(), /Terms the owner uses often: HareDream$/);
    } finally {
        await m.dispose();
    }
});

test("memory stays bounded", async () => {
    const m = await memory();

    try {
        const many = Array.from({ length: 20 }, (_, i) => ({ heard: `w${i}`, wanted: `W${i}` }));

        for (let round = 0; round < 20; round++) {
            await m.memory.learn(
                many.map((c) => ({ heard: `${c.heard}-${round}`, wanted: c.wanted })),
                [],
            );
        }

        assert.ok((await m.memory.list()).corrections.length <= 300);
        assert.ok((await m.memory.promptText()).split("\n").length <= 102);
        await m.memory.learn(
            Array.from({ length: 50 }, (_, i) => ({ heard: `extra${i}`, wanted: "E" })),
            [],
        );
        assert.ok(
            (await m.memory.list()).corrections.filter((c) => c.heard.startsWith("extra")).length <=
                20,
        );
    } finally {
        await m.dispose();
    }
});

test("usage is totalled per day and old days are dropped", async () => {
    const m = await memory();
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 17, 12);
    const usage = { input: 100, output: 20, cacheRead: 300, cost: { total: 0.01 } };

    try {
        await m.memory.recordUsage(usage, 2000, now - 50 * day);
        await m.memory.recordUsage(usage, 2000, now - 10 * day);
        await m.memory.recordUsage(usage, 1000, now);
        await m.memory.recordUsage(usage, 3000, now);

        const stats = await m.memory.stats(now);

        assert.equal(stats.today.cleanups, 2);
        assert.equal(stats.today.averageSeconds, 2);
        assert.equal(stats.today.cachedInputTokens, 600);
        assert.equal(stats.last7Days.cleanups, 2);
        assert.equal(stats.last30Days.cleanups, 3);
        assert.ok(Math.abs(stats.last30Days.cost - 0.03) < 1e-9);
        assert.doesNotMatch(
            await readFile(join(m.dir, "dictation-usage.json"), "utf8"),
            /2026-09-0/,
        );
    } finally {
        await m.dispose();
    }
});

test("edits that fix a mis-heard name are learned; rewording and typed text are not", () => {
    const learn = (value: string, inserted: string, final: string) =>
        learnFrom({ value, inserted }, final);

    assert.deepEqual(
        learn(
            "Check pie pocket and hare dream.",
            "Check pie pocket and hare dream.",
            "Check Pi Pocket and HareDream.",
        ),
        {
            corrections: [
                { heard: "pie pocket", wanted: "Pi Pocket" },
                { heard: "hare dream", wanted: "HareDream" },
            ],
            terms: ["HareDream"],
        },
    );
    assert.deepEqual(learn("Check the build.", "Check the build.", "Verify the build."), {
        corrections: [],
        terms: [],
    });
    assert.deepEqual(
        learn(
            "typed words. Use clicker train.",
            "Use clicker train.",
            "typed text. Use ClickerTrain.",
        ),
        {
            corrections: [{ heard: "clicker train", wanted: "ClickerTrain" }],
            terms: ["ClickerTrain"],
        },
    );
    assert.deepEqual(
        learn(
            "Use claude haiku five five.",
            "Use claude haiku five five.",
            "Use claude-haiku-5-5 please.",
        ).corrections,
        [{ heard: "claude haiku five five", wanted: "claude-haiku-5-5" }],
    );
    // Nothing changed, a pure addition, and a huge draft all teach nothing; names kept as they were still count.
    assert.deepEqual(learn("Use Dandori.", "Use Dandori.", "Use Dandori."), {
        corrections: [],
        terms: [],
    });
    assert.deepEqual(learn("Run it.", "Run it.", "Run it now.").corrections, []);
    assert.deepEqual(learn("w ".repeat(700), "w", "x ".repeat(700)), {
        corrections: [],
        terms: [],
    });
    assert.equal(plausibleFix("check", "verify"), false);
    assert.equal(plausibleFix("dandori", "Dandori"), true);
    assert.equal(plausibleFix("mon", "Pi-Mon"), true);
});
