import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Dictation } from "../src/server/dictation.ts";
import { Spend } from "../src/server/spend.ts";
import { UsageDoc } from "@earendil-works/pi-durable";
const CORE_MODULE: string = "../web/dictation-core.js";
const { createDictation, placeDictation } = await import(CORE_MODULE);

const owner: any = { id: "owner", role: "owner" };
const id: any = 1;
const usage = {
    input: 10,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 22,
    cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
};

async function backend(
    options: {
        stopReason?: string;
        errorMessage?: string;
        text?: string;
        missing?: boolean;
        run?: () => Promise<void>;
        cwd?: string;
    } = {},
) {
    const directory = await mkdtemp(join(tmpdir(), "voice-tests-"));
    const requests: any[] = [];
    const ledger: any = { models: {} };
    const app: any = {
        requireSee() {},
        sessionMeta: () => ({}),
        agentState: async () => ({
            cwd: options.cwd ?? "mm://duriel-linux/home/duriel/Development/Pi Mon",
        }),
        spend: {
            check() {},
            async recordSupplementalUsage(_id: any, _payer: string, key: string, u: any) {
                ledger.models[key] = structuredClone(u);
            },
        },
        transcripts: { recentText: async () => "Person: check Pi Mon\nPi: Looking at HareDream." },
        skillCommands: () => [{ name: "dandori" }, { name: "clickertrain" }],
        promptTemplates: () => [{ name: "review" }],
        workers: {
            resources: async () => ({}),
            rpc: async (folder: string) => ({
                dirs: folder.endsWith("Development")
                    ? [
                          { name: "HareDream" },
                          { name: "Pi Mon" },
                          { name: "pimon-wt-main" },
                          { name: "gz-wt" },
                          { name: "Baark-landing" },
                      ]
                    : [{ name: "src" }],
            }),
        },
        defaultCwd: "/tmp",
        log() {},
        models: {
            getAvailableSnapshot: () =>
                options.missing
                    ? []
                    : [
                          {
                              id: "gpt-6-luna",
                              name: "GPT-6 Luna",
                              provider: "openai-codex",
                              api: "openai-codex-responses",
                          },
                      ],
            async completeSimple(...args: any[]) {
                requests.push(args);
                await options.run?.();

                return {
                    content: [{ type: "text", text: options.text ?? "Use Pi Pocket." }],
                    stopReason: options.stopReason ?? "stop",
                    ...(options.errorMessage === undefined
                        ? {}
                        : { errorMessage: options.errorMessage }),
                    usage,
                };
            },
        },
        harness: { commit: async (fn: any) => fn({ doc: async () => ledger }) },
    };
    const service = new Dictation(app, directory);

    return {
        directory,
        app,
        service,
        requests,
        ledger,
        dispose: () => rm(directory, { recursive: true }),
    };
}

const body = { text: "use pie pocket", requestId: "voice-test-123" };

test("cleanup is medium, bounded, tool-free, stable-prefix; duplicates only cost once", async () => {
    const b = await backend();

    try {
        const result = await b.service.cleanup(owner, id, body);
        const duplicate = await b.service.cleanup(owner, id, body);

        assert.equal(result.text, "Use Pi Pocket.");
        assert.equal(duplicate.cached, true);
        assert.equal(b.requests.length, 1);
        const [, prompt, opts] = b.requests[0];

        assert.equal(opts.reasoning, "medium");
        assert.equal(opts.maxTokens, 2048);
        const wire = await opts.onPayload(
            { model: "gpt-6-luna" },
            { api: "openai-codex-responses" },
        );

        assert.equal(wire.service_tier, "priority");
        assert.equal(result.fast, true);
        assert.equal(opts.maxRetries, 0);
        assert.equal(opts.transport, "sse");
        assert.equal(opts.signal.aborted, false);
        assert.match(opts.sessionId, /^dictation-/);
        assert.equal(prompt.messages.length, 1);
        assert.equal(prompt.tools, undefined);
        assert.match(prompt.systemPrompt, /Pi Pocket/);
        assert.match(prompt.systemPrompt, /Environment reference/);
        assert.match(prompt.systemPrompt, /HareDream, Pi Mon, Baark-landing/);
        assert.match(prompt.systemPrompt, /Folders inside it: src/);
        assert.doesNotMatch(prompt.systemPrompt, /pimon-wt|gz-wt/);
        assert.match(
            prompt.systemPrompt,
            /Skills \(spoken as plain names\): dandori, clickertrain/,
        );
        assert.match(prompt.systemPrompt, /Prompt templates: \/review/);
        assert.match(prompt.systemPrompt, /Models \(ids and names\): gpt-6-luna, GPT-6 Luna/);
        assert.match(prompt.systemPrompt, /closest name/);
        assert.ok(
            prompt.systemPrompt.indexOf("Vocabulary reference") <
                prompt.systemPrompt.indexOf("Environment reference"),
        );
        assert.equal((await b.service.memory.stats()).today.cleanups, 1);
        assert.match(prompt.systemPrompt, /Computer: duriel-linux/);
        assert.match(
            JSON.parse(prompt.messages[0].content).recentConversation,
            /Looking at HareDream/,
        );
        assert.equal(JSON.parse(prompt.messages[0].content).project, "Pi Mon");
        assert.equal(b.ledger.models["openai-codex/gpt-6-luna"].totalTokens, 22);
        await assert.rejects(
            b.service.cleanup(owner, id, { ...body, text: "different" }),
            /already used/,
        );
    } finally {
        await b.dispose();
    }
});

test("what the owner taught it reaches the prompt last; only the owner can teach or look", async () => {
    const b = await backend();

    try {
        await b.service.learn(owner, {
            corrections: [{ heard: "pie mon", wanted: "Pi Mon" }],
            terms: ["HareDream", "HareDream", "HareDream"],
        });
        await b.service.cleanup(owner, id, body);

        const prompt = b.requests[0][1].systemPrompt as string;

        assert.match(prompt, /- pie mon → Pi Mon/);
        assert.match(prompt, /Terms the owner uses often: HareDream/);
        assert.ok(
            prompt.indexOf("Environment reference") <
                prompt.indexOf("Spellings the owner corrected"),
        );

        const listed = await b.service.learned(owner);

        assert.equal(listed.corrections.length, 1);
        assert.equal(listed.usage.today.cleanups, 1);
        await assert.rejects(b.service.learned({ id: "g", role: "guest" } as any), /owner-only/);
        await assert.rejects(b.service.learn({ id: "g", role: "guest" } as any, {}), /owner-only/);
        await assert.rejects(
            b.service.forget({ id: "g", role: "viewer" } as any, {}),
            /owner-only/,
        );
        assert.deepEqual(await b.service.forget(owner, { kind: "correction", key: "pie mon" }), {
            removed: true,
        });
    } finally {
        await b.dispose();
    }
});

test("a local session lists its neighbouring folders, not hidden ones, files or node_modules", async () => {
    const base = await mkdtemp(join(tmpdir(), "voice-folders-"));

    try {
        for (const dir of ["Alpha/web", "Beta", ".hidden", "node_modules"]) {
            await mkdir(join(base, dir), { recursive: true });
        }

        await writeFile(join(base, "notes.txt"), "not a folder");
        const b = await backend({ cwd: join(base, "Alpha") });

        try {
            await b.service.cleanup(owner, id, body);
            const prompt = b.requests[0][1].systemPrompt as string;

            assert.match(prompt, /Working folder: .*Alpha/);
            assert.match(prompt, /Alpha, Beta\n/);
            assert.match(prompt, /Folders inside it: web/);
            assert.doesNotMatch(prompt, /\.hidden|node_modules|notes\.txt/);
        } finally {
            await b.dispose();
        }
    } finally {
        await rm(base, { recursive: true });
    }
});

test("vocabulary is bounded Markdown with optimistic concurrency and private writes", async () => {
    const b = await backend();

    try {
        const initial = await b.service.vocabulary(owner);
        const next = await b.service.saveVocabulary(
            owner,
            "# Words\n- HareDream\n",
            initial.revision,
        );

        assert.notEqual(initial.revision, next.revision);
        assert.equal(await readFile(next.path, "utf8"), next.text);
        await assert.rejects(
            b.service.saveVocabulary(owner, "other", initial.revision),
            /changed elsewhere/,
        );
        await assert.rejects(
            b.service.saveVocabulary(owner, "x".repeat(8001), next.revision),
            /8,000/,
        );
        await assert.rejects(b.service.vocabulary({ id: "g", role: "guest" } as any), /owner-only/);
    } finally {
        await b.dispose();
    }
});

test("rejects viewers, invalid inputs, spend limits, unknown sessions; no network calls", async () => {
    const b = await backend();

    try {
        await assert.rejects(
            b.service.cleanup({ id: "g", role: "viewer" } as any, id, body),
            /owner-only/,
        );
        await assert.rejects(
            b.service.cleanup(owner, id, { ...body, text: "x".repeat(4001) }),
            /4,000/,
        );
        await assert.rejects(
            b.service.cleanup(owner, id, { ...body, requestId: "bad" }),
            /requestId/,
        );
        b.app.sessionMeta = () => undefined;
        await assert.rejects(b.service.cleanup(owner, id, body), /No such session/);
        b.app.sessionMeta = () => ({});

        b.app.spend.check = () => {
            throw new Error("spend limit");
        };

        await assert.rejects(b.service.cleanup(owner, id, body), /spend limit/);
        assert.equal(b.requests.length, 0);
    } finally {
        await b.dispose();
    }
});

test("truncated replies still count usage and are not retried; priority is always requested", async () => {
    const b = await backend({ stopReason: "length" });

    try {
        await assert.rejects(b.service.cleanup(owner, id, body), /did not finish/);
        await assert.rejects(b.service.cleanup(owner, id, body), /did not finish/);
        assert.equal(
            (await b.requests[0][2].onPayload({}, { api: "openai-codex-responses" })).service_tier,
            "priority",
        );
        assert.equal(b.requests.length, 1);
        assert.equal(b.ledger.models["openai-codex/gpt-6-luna"].totalTokens, 22);
    } finally {
        await b.dispose();
    }
});

test("concurrent identical requests coalesce; a new request is rate limited", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
    });
    const b = await backend({ run: () => gate });

    try {
        const first = b.service.cleanup(owner, id, body);
        const second = b.service.cleanup(owner, id, body);

        await new Promise((r) => setTimeout(r, 20));
        await assert.rejects(
            b.service.cleanup(owner, id, { ...body, requestId: "voice-another" }),
            /Please wait/,
        );
        release();
        await Promise.all([first, second]);
        assert.equal(b.requests.length, 1);
    } finally {
        release();
        await b.dispose();
    }
});

test("a provider's refusal is explained to the owner, not hidden as an unusable answer", async () => {
    const b = await backend({
        stopReason: "error",
        errorMessage: "401 token expired\nplease sign in",
    });

    try {
        await assert.rejects(
            b.service.cleanup(owner, id, body),
            /did not finish \(error: 401 token expired please sign in\); keeping the raw transcript/,
        );
    } finally {
        await b.dispose();
    }

    const empty = await backend({ text: "" });

    try {
        await assert.rejects(empty.service.cleanup(owner, id, body), /\(stop: empty reply\)/);
    } finally {
        await empty.dispose();
    }
});

test("unavailable Luna never silently substitutes a model", async () => {
    const b = await backend({ missing: true });

    try {
        await assert.rejects(b.service.cleanup(owner, id, body), /unavailable/);
        assert.equal(b.requests.length, 0);
    } finally {
        await b.dispose();
    }
});

function frontend(clean: (text: string, signal: AbortSignal) => Promise<string>) {
    const engines: any[] = [];

    class Recognition {
        onend: any;
        onresult: any;
        onerror: any;
        constructor() {
            engines.push(this);
        }
        start() {}
        stop() {
            this.onend();
        }
        abort() {}
        say(...parts: string[]) {
            this.onresult({ results: parts.map((text) => [{ transcript: text }]) });
        }
    }
    let text = "before AFTER";
    let scope = 1;
    let status: any;
    const errors: string[] = [];
    const settled: any[] = [];
    const voice = createDictation({
        Recognition,
        read: () => ({ text, from: 7, to: 7, scope }),
        write: (value: string) => {
            text = value;
        },
        clean,
        change: (s: any) => {
            status = s;
        },
        error: (e: string) => errors.push(e),
        settled: (info: any) => settled.push(info),
    });

    return {
        voice,
        engines,
        errors,
        settled,
        read: () => text,
        switchScope: () => {
            scope++;
        },
        type: (t: string) => {
            voice.cancel();
            text = t;
        },
        status: () => status,
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("recognition restarts do not clean; manual stop cleans only dictated span and supports Undo", async () => {
    let n = 0;
    const f = frontend(async (text) => {
        n++;
        assert.equal(text, "pie pocket words");

        return "Pi Pocket words.";
    });

    try {
        f.voice.start();
        f.engines[0].say("pie pocket");
        f.engines[0].onend();
        assert.equal(n, 0);
        f.engines[1].say("words");
        f.voice.stop();
        await tick();
        assert.equal(n, 1);
        assert.equal(f.read(), "before Pi Pocket words. AFTER");
        assert.equal(f.status().hasUndo, true);
        f.voice.undo();
        assert.equal(f.read(), "before pie pocket words AFTER");
    } finally {
        f.voice.cancel();
    }
});

test("typing/switching while cleanup awaits prevents stale overwrite", async () => {
    let resolve!: (v: string) => void;
    let signal!: AbortSignal;
    const f = frontend((_t, s) => {
        signal = s;

        return new Promise((r) => {
            resolve = r;
        });
    });

    try {
        f.voice.start();
        f.engines[0].say("raw words");
        f.voice.stop();
        assert.equal(f.status().polishing, true);
        f.type("my new typed words");
        resolve("Incorrect overwrite");
        await tick();
        assert.equal(signal.aborted, true);
        assert.equal(f.read(), "my new typed words");
        assert.equal(f.status().polishing, false);
    } finally {
        f.voice.cancel();
    }
});

test("a session change with identical draft text cannot receive stale cleanup before effects run", async () => {
    let resolve!: (value: string) => void;
    const f = frontend(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );

    try {
        f.voice.start();
        f.engines[0].say("raw words");
        f.voice.stop();
        f.switchScope();
        resolve("Changed text.");
        await tick();
        assert.equal(f.read(), "before raw words AFTER");
        assert.equal(f.status().hasUndo, false);
    } finally {
        f.voice.cancel();
    }
});

test("a finished dictation reports what it inserted so later edits can teach, cleaned or not", async () => {
    const cleaned = frontend(async () => "Use Pi Pocket.");

    try {
        cleaned.voice.start();
        cleaned.engines[0].say("use pie pocket");
        cleaned.voice.stop();
        await tick();
        assert.deepEqual(cleaned.settled, [
            { scope: 1, value: "before Use Pi Pocket. AFTER", inserted: "Use Pi Pocket." },
        ]);
    } finally {
        cleaned.voice.cancel();
    }

    const same = frontend(async (text) => text);

    try {
        same.voice.start();
        same.engines[0].say("use pie pocket");
        same.voice.stop();
        await tick();
        assert.equal(same.settled.at(-1).inserted, "use pie pocket");
    } finally {
        same.voice.cancel();
    }

    const failed = frontend(async () => {
        throw new Error("down");
    });

    try {
        failed.voice.start();
        failed.engines[0].say("hello there");
        failed.voice.stop();
        await tick();
        assert.deepEqual(failed.settled, [], "a failed cleanup teaches nothing");
    } finally {
        failed.voice.cancel();
    }
});

test("cleanup failure leaves raw text and does not send anything", async () => {
    const f = frontend(async () => {
        throw new Error("provider down");
    });

    try {
        f.voice.start();
        f.engines[0].say("raw words");
        f.voice.stop();
        await tick();
        assert.equal(f.read(), "before raw words AFTER");
        assert.match(f.errors[0]!, /raw words kept/);
        assert.equal(f.status().polishing, false);
    } finally {
        f.voice.cancel();
    }
});

test("supplemental cleanup usage charges its owner, not the guest driving the agent", async () => {
    const doc: any = { models: {} };
    const spendDoc: any = { counted: {}, people: {} };
    let spend: Spend;
    const app: any = {
        rootOf: () => id,
        sessionMeta: () => ({}),
        attribution: { requesterOf: () => "guest" },
        busyConversations: () => [],
        config: {
            users: [owner],
            userById: (uid: string) => ({ id: uid, role: uid === "owner" ? "owner" : "guest" }),
        },
        log() {},
        harness: {
            async commit(fn: any) {
                let touched = false;
                const result = await fn({
                    doc: async (kind: any) => {
                        if (kind === UsageDoc) {
                            touched = true;

                            return doc;
                        }

                        return spendDoc;
                    },
                });

                if (touched) {
                    spend.usageChanged(id, doc);
                }

                return result;
            },
        },
    };

    spend = new Spend(app);

    try {
        await spend.recordSupplementalUsage(id, "owner", "openai-codex/gpt-6-luna", usage);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(spend.personSpent("owner"), 0.02);
        assert.equal(spend.personSpent("guest"), 0);
    } finally {
        spend.close();
    }
});

test("spacing respects selection replacement and existing punctuation", () => {
    assert.equal(placeDictation("aXXb", 1, 3, "word").value, "a word b");
    assert.equal(placeDictation("hello!", 5, 5, ",").value, "hello,!");
    assert.equal(placeDictation("", 0, 0, "first").value, "first");
});
