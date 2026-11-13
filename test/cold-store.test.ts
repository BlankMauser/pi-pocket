// The cold store of finished subagents (`cold-store.ts`): which subagents a pass may archive, that an archive copies
// every row exactly, verifies it, and only then deletes the local rows, that a crash at any step leaves either every
// local row or a sealed, verified cold copy, that every path back to a subagent restores it row for row, and that a
// cold store that does not answer fails that conversation alone. The cold store is an in-process fake.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    newSession,
    offerSubagents,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import {
    type ColdClient,
    ColdConflict,
    type ColdRow,
    type ColdStep,
    ColdUnavailable,
    coldStoreFromEnv,
    HttpColdClient,
} from "../src/server/cold-store.ts";
import { SubagentsDoc } from "../src/server/docs.ts";
import { HttpError } from "../src/server/errors.ts";

/** The cold store's API in memory, paging a few rows at a time so that paging is exercised. */
class FakeCold implements ColdClient {
    units = new Map<string, { rows: Map<number, ColdRow>; sealed: boolean }>();
    down = false;
    puts = 0;
    /** Changes a row on its way back, as a cold store that lost or garbled it would. */
    garble: ((row: ColdRow) => ColdRow) | undefined;
    readonly pageRows = 3;

    #check(): void {
        if (this.down) {
            throw new ColdUnavailable("The cold store did not answer: fake outage");
        }
    }

    #unit(unit: string) {
        let found = this.units.get(unit);

        if (found === undefined) {
            found = { rows: new Map(), sealed: false };
            this.units.set(unit, found);
        }

        return found;
    }

    async put(unit: string, rows: readonly ColdRow[]): Promise<void> {
        this.#check();
        const found = this.#unit(unit);

        if (found.sealed) {
            throw new ColdConflict("sealed");
        }

        this.puts++;

        for (const row of rows) {
            found.rows.set(row.id, { ...row });
        }
    }

    async page(unit: string, after: number): Promise<{ rows: ColdRow[]; next: number | null }> {
        this.#check();
        const all = [...this.#unit(unit).rows.values()]
            .filter((row) => row.id > after)
            .sort((a, b) => a.id - b.id);
        const rows = all
            .slice(0, this.pageRows)
            .map((row) => this.garble?.({ ...row }) ?? { ...row });

        return { rows, next: all.length > this.pageRows ? rows.at(-1)!.id : null };
    }

    async summary(unit: string): Promise<{ rows: number; bytes: number; sealed: boolean }> {
        this.#check();
        const found = this.#unit(unit);
        const rows = [...found.rows.values()];

        return {
            rows: rows.length,
            bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.record), 0),
            sealed: found.sealed,
        };
    }

    async seal(unit: string, rows: number, bytes: number): Promise<void> {
        const have = await this.summary(unit);

        if (have.rows !== rows || have.bytes !== bytes) {
            throw new ColdConflict("count mismatch");
        }

        this.#unit(unit).sealed = true;
    }

    async remove(unit: string): Promise<void> {
        this.#check();
        this.units.delete(unit);
    }

    /** A copy of what it holds now: the cold store as a crash finds it. */
    clone(): FakeCold {
        const copy = new FakeCold();

        for (const [name, unit] of this.units) {
            copy.units.set(name, {
                sealed: unit.sealed,
                rows: new Map([...unit.rows].map(([id, row]) => [id, { ...row }])),
            });
        }

        return copy;
    }
}

/** Subagents whose next answer runs a `sleep` first, so they are at work for a while. */
const slow = new Set<string>();
/** For each subagent sent "One more thing.", whether its context then held its first answer. */
const sawEarlier: Record<string, boolean> = {};

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        if (slow.has(subagent) && role !== "toolResult") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2" })], {
                stopReason: "toolUse",
            });
        }

        if (text === "One more thing.") {
            sawEarlier[subagent] = all.includes(`result of ${subagent}`);
        }

        return fauxAssistantMessage([fauxText(`result of ${subagent}`)]);
    }

    const spawn = /^spawn (\S+)$/.exec(text);

    if (spawn !== null) {
        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: "spawn", name: spawn[1]!, message: "Check it." })],
            { stopReason: "toolUse" },
        );
    }

    const nudge = /^nudge (\S+)$/.exec(text);

    if (nudge !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "send",
                    name: nudge[1]!,
                    message: "One more thing.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

const cold = new FakeCold();
/** Called after each step of an archive (`ColdOptions.onStep`); tests set it to stop or hold one there. */
let onStep: ((step: ColdStep, id: number) => void | Promise<void>) | undefined;
const dataDir = join(root, "cold-data");
let app: App;
let parent: ConversationId;

/** What the apps logged. */
const logs: string[] = [];

const open = (dir: string, client: ColdClient | null) =>
    openApp(scriptedModel(route), dir, undefined, undefined, {
        log: (line) => logs.push(line),
        coldStore:
            client === null
                ? null
                : { client, inUseMs: 0, onStep: (step, id) => onStep?.(step, id) },
    });

before(async () => {
    app = await open(dataDir, cold);
    offerSubagents(app);
    parent = await newSession(app);
});

after(async () => {
    await app?.close();
    cleanUp();
});

type Row = {
    id: number;
    conversation_id: number;
    head: number | null;
    commit_seq: number;
    record: string;
};

/** Read `pocket.sqlite` of `dir` as it stands, on a connection of the test's own. */
function sql<T>(dir: string, query: string, ...params: (number | string)[]): T[] {
    const db = new DatabaseSync(join(dir, "pocket.sqlite"), { readOnly: true });

    try {
        // Plain objects, which compare equal to literals.
        return db
            .prepare(query)
            .all(...params)
            .map((row) => ({ ...row })) as T[];
    } finally {
        db.close();
    }
}

const rowsOf = (id: ConversationId, dir = dataDir) =>
    sql<Row>(
        dir,
        "SELECT id, conversation_id, head, commit_seq, record FROM entries WHERE conversation_id = ? ORDER BY id",
        Number(id),
    );

/** A hash of every row of the tables an archive must leave alone. */
function otherTables(dir = dataDir): Record<string, string> {
    const tables = [
        "conversations",
        "tasks",
        "submissions",
        "documents",
        "document_revisions",
        "record_ids",
    ];

    return Object.fromEntries(
        tables.map((table) => [
            table,
            createHash("sha256")
                .update(JSON.stringify(sql(dir, `SELECT * FROM ${table} ORDER BY rowid`)))
                .digest("hex"),
        ]),
    );
}

/** The rows an archived conversation keeps here: its newest entry and its newest head marker. */
const keptOf = (rows: Row[]) =>
    rows.filter(
        (row) =>
            row.id === rows.at(-1)!.id ||
            row.id === rows.findLast((each) => each.head !== null)?.id,
    );

/** Spawn a subagent of `parent`, wait until its report reached the parent and a pass may take it; its id. */
async function finished(name: string, on = app, from = parent): Promise<ConversationId> {
    await say(on, from, `spawn ${name}`);

    let id: ConversationId | undefined;

    await until(
        async () => {
            id = (await on.harness.snapshot(SubagentsDoc, from, context))?.agents[name]
                ?.conversationId;

            return (
                id !== undefined &&
                !on.isBusy(from) &&
                (await on.cold.pass({ dryRun: true, ageMs: 0, limit: 1000 })).selected.some(
                    (each) => each.id === Number(id),
                )
            );
        },
        `${name} finished`,
        15_000,
    );

    return id!;
}

/** Archive just `id`: a pass that takes every eligible subagent, as others may be eligible too. */
async function archive(on = app) {
    return on.cold.pass({ ageMs: 0, limit: 1000 });
}

test("with no cold store set up, nothing changes: no table, no pass, nothing cold", async () => {
    const dir = join(root, "cold-off");
    const off = await open(dir, null);

    try {
        assert.equal(off.cold.configured, false);
        await assert.rejects(off.cold.pass({ dryRun: true }), (error: unknown) => {
            return error instanceof HttpError && error.status === 409;
        });
        assert.equal(off.cold.warm(1 as ConversationId), undefined);
    } finally {
        await off.close();
    }

    // Regression: a Pocket without a cold store must not change the schema of the owner's database.
    assert.deepEqual(
        sql(dir, "SELECT name FROM sqlite_master WHERE name = 'pocket_cold_units'"),
        [],
    );
});

test("the cold store's settings: the key from a file or the environment, never shown; only https or this machine", () => {
    const dir = join(root, "cold-env");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "key"), "secret-from-file\n");

    assert.equal(coldStoreFromEnv({}), undefined, "off without a URL");
    assert.equal(
        coldStoreFromEnv({
            PI_POCKET_COLD_STORE_URL: "https://cold.example",
            PI_POCKET_COLD_STORE_KEY_FILE: join(dir, "key"),
        })?.ageMs,
        24 * 60 * 60 * 1000,
        "24 hours by default",
    );
    assert.equal(
        coldStoreFromEnv({
            PI_POCKET_COLD_STORE_URL: "http://127.0.0.1:8788",
            PI_POCKET_COLD_STORE_KEY: "k",
            PI_POCKET_COLD_STORE_AGE_HOURS: "2",
        })?.ageMs,
        2 * 60 * 60 * 1000,
    );
    assert.throws(
        () => coldStoreFromEnv({ PI_POCKET_COLD_STORE_URL: "https://cold.example" }),
        /no key/,
        "a URL without a key is an error, not a store that every request is refused by",
    );
    assert.throws(
        () =>
            coldStoreFromEnv({
                PI_POCKET_COLD_STORE_URL: "http://cold.example",
                PI_POCKET_COLD_STORE_KEY: "secret-in-env",
            }),
        (error: unknown) => !String(error).includes("secret") && /https/.test(String(error)),
        "the key does not go out in clear text, and an error never shows it",
    );
    assert.throws(() => new HttpColdClient("ftp://127.0.0.1", "k"), /https/);
});

test("a finished subagent may be archived; one that is open, at work, forked, quiet too briefly, or whose report waits may not", async () => {
    const id = await finished("elig");

    const skippedFor = async (options: { ageMs: number }) => {
        const report = await app.cold.pass({ dryRun: true, limit: 1000, ...options });

        return { selected: report.selected.some((each) => each.id === Number(id)), report };
    };

    assert.equal((await skippedFor({ ageMs: 0 })).selected, true);
    // The age: its newest entry is seconds old.
    const recent = await skippedFor({ ageMs: 60 * 60 * 1000 });

    assert.equal(recent.selected, false, "quiet for less than the age");
    assert.ok((recent.report.skipped.recent ?? 0) >= 1);
    // A root session is never a candidate.
    assert.equal(
        (await app.cold.pass({ dryRun: true, ageMs: 0, limit: 1000 })).selected.some(
            (each) => each.id === Number(parent),
        ),
        false,
    );

    // Its report not taken yet: in the parent's outbox.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, parent)).outbox = [{ name: "elig", text: "waiting" }];
    }, context);
    assert.equal(
        (await skippedFor({ ageMs: 0 })).selected,
        false,
        "its report waits in the outbox",
    );
    await app.harness.commit(async (tx) => {
        delete (await tx.doc(SubagentsDoc, parent)).outbox;
    }, context);
    assert.equal((await skippedFor({ ageMs: 0 })).selected, true);

    // At work.
    slow.add("elig");
    await say(app, parent, "nudge elig");
    await until(() => app.isBusy(id), "elig at work");
    assert.equal((await skippedFor({ ageMs: 0 })).selected, false, "at work");
    slow.delete("elig");
    await until(async () => (await skippedFor({ ageMs: 0 })).selected, "elig done again", 15_000);

    // Forked: the fork reads its rows.
    const conversation = (await app.harness.conversation(id, context))!;
    const newest = rowsOf(id).at(-1)!.id;

    await conversation.fork(
        newest as unknown as EntryId,
        { ownership: { kind: "ownerless" } },
        context,
    );
    const forked = await skippedFor({ ageMs: 0 });

    assert.equal(forked.selected, false, "a conversation forks from it");
    assert.ok((forked.report.skipped.forked ?? 0) >= 1);
});

test("a subagent open in a tab is not archived", async () => {
    const id = await finished("open");
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);

    try {
        const report = await archive();

        assert.equal(
            report.selected.some((each) => each.id === Number(id)),
            false,
        );
        assert.ok((report.skipped.open ?? 0) >= 1);
        assert.equal(app.cold.isCold(id), false);
    } finally {
        app.detach(tab.client);
    }
});

test("an archive copies every row exactly, deletes all but the two it keeps, and changes no other table", async () => {
    const id = await finished("copy");
    const before = rowsOf(id);
    const tables = otherTables();
    const report = await archive();

    assert.ok(report.archived.conversations >= 1);
    assert.deepEqual(report.failed, []);
    assert.equal(app.cold.isCold(id), true);

    const unit = cold.units.get(`conv-${id}`)!;

    assert.equal(unit.sealed, true);
    // Byte for byte: id, head, commit seq, and the record's text.
    assert.deepEqual(
        [...unit.rows.values()].sort((a, b) => a.id - b.id),
        before.map(({ id: row, head, commit_seq, record }) => ({
            id: row,
            head,
            commit_seq,
            record,
        })),
    );
    // Regression: Durable keeps the newest entry and head marker in memory once read; both stay here.
    assert.deepEqual(rowsOf(id), keptOf(before));
    assert.ok(before.length > keptOf(before).length, "it had rows to delete");
    assert.deepEqual(
        otherTables(),
        tables,
        "conversations, tasks, submissions, documents, record_ids",
    );
    assert.deepEqual(
        sql(
            dataDir,
            "SELECT state, rows FROM pocket_cold_units WHERE conversation_id = ?",
            Number(id),
        ),
        [{ state: "archived", rows: before.length }],
    );
    // Its usage as counted when it went.
    assert.ok((app.cold.usageOf(id)?.requests ?? 0) >= 1);

    const status = await app.cold.status();

    assert.ok(status.archived >= 1);
    assert.ok(status.freedBytes > 0 && status.freedBytes < status.bytes);
});

test("a head marker between deleted rows stays, and the rows on both sides of it go", async () => {
    const id = await finished("marked");

    // A new context (`pi.reset`) and a message after it: the newest head marker is now in the middle.
    await (await app.conversation(id)).reset("carry on", context);
    await say(app, id, "after the reset");
    await until(
        async () =>
            (await app.cold.pass({ dryRun: true, ageMs: 0, limit: 1000 })).selected.some(
                (each) => each.id === Number(id),
            ),
        "marked quiet again",
        15_000,
    );

    const before = rowsOf(id);
    const kept = keptOf(before);

    assert.equal(kept.length, 2);
    assert.ok(
        before.some((row) => row.id < kept[0]!.id) &&
            before.some((row) => row.id > kept[0]!.id && row.id < kept[1]!.id),
        "rows on both sides of the marker",
    );

    const report = await archive();

    // Regression: one delete range spanned the kept marker, deleted one row too many, and the archive failed.
    assert.deepEqual(report.failed, []);
    assert.equal(app.cold.isCold(id), true);
    assert.deepEqual(rowsOf(id), kept);
    await app.conversation(id);
    assert.deepEqual(rowsOf(id), before);
});

test("a second pass archives nothing new and sends nothing", async () => {
    await finished("twice");
    await archive();
    const puts = cold.puts;
    const again = await archive();

    assert.equal(again.archived.conversations, 0);
    assert.equal(cold.puts, puts, "nothing sent again");
});

test("opening an archived subagent brings back every row as it was, and it can go cold again", async () => {
    const id = await finished("back");
    const before = rowsOf(id);

    await archive();
    assert.equal(app.cold.isCold(id), true);
    await app.conversation(id);
    assert.equal(app.cold.isCold(id), false);
    assert.deepEqual(rowsOf(id), before, "row for row");
    assert.equal(cold.units.has(`conv-${id}`), false, "the cold copy goes once the rows are back");
    assert.deepEqual(
        sql(dataDir, "SELECT * FROM pocket_cold_units WHERE conversation_id = ?", Number(id)),
        [],
    );

    // Its history reads whole.
    const history = await app.transcripts.history(id, Number.MAX_SAFE_INTEGER);

    assert.ok(history.length > 0);
    const again = await archive();

    assert.equal(app.cold.isCold(id), true, `archived again: ${JSON.stringify(again)}`);
});

test("a tab that opens an archived subagent, or its history, brings it back first", async () => {
    const id = await finished("tabbed");
    const before = rowsOf(id);

    await archive();
    assert.equal(app.cold.isCold(id), true);

    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    assert.equal(app.cold.isCold(id), false);
    assert.deepEqual(rowsOf(id), before);
    app.detach(tab.client);

    // Its history, read without a tab (`GET /history`).
    const other = await finished("history");
    const was = rowsOf(other);

    await archive();
    assert.equal(app.cold.isCold(other), true);
    await app.transcripts.history(other, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(rowsOf(other), was, "history restores too");
});

test("a send to an archived subagent restores it first: it works on its whole context, not an empty one", async () => {
    const id = await finished("resend");
    const before = rowsOf(id);

    await archive();
    assert.equal(app.cold.isCold(id), true);
    await say(app, parent, "nudge resend");
    await until(() => sawEarlier.resend !== undefined, "the subagent's answer", 15_000);
    // Regression: the subagent ran on its rows; without the restore it would start on an empty context.
    assert.equal(sawEarlier.resend, true);
    // Restored by the send itself, before the message went: not by `guard`, which only races the run.
    assert.equal(
        logs.filter((line) => line.includes(`conversation ${id} was written past warm()`)).length,
        0,
    );
    assert.deepEqual(rowsOf(id).slice(0, before.length), before);
});

test("a cold store that does not answer fails that conversation alone; the server and every other session go on", async () => {
    const id = await finished("outage");
    const before = rowsOf(id);

    cold.down = true;

    try {
        const failed = await archive();

        assert.match(failed.stopped ?? "", /did not answer/);
        assert.equal(app.cold.isCold(id), false, "nothing deleted without a cold copy");
        assert.deepEqual(rowsOf(id), before);
    } finally {
        cold.down = false;
    }

    await archive();
    assert.equal(app.cold.isCold(id), true);
    cold.down = true;

    try {
        await assert.rejects(app.conversation(id), (error: unknown) => {
            return (
                error instanceof HttpError &&
                error.status === 503 &&
                error.message.includes(String(id))
            );
        });
        assert.equal(app.cold.isCold(id), true, "still cold, still whole in the cold store");
        assert.match((await app.cold.status(false)).lastError?.message ?? "", /Restore failed/);
        // The rest of the server works: the parent takes a turn.
        await say(app, parent, "still here?");
        await app.conversation(parent);
    } finally {
        cold.down = false;
    }

    await app.conversation(id);
    assert.deepEqual(rowsOf(id), before, "back once the cold store answers");
});

test("a cold copy that differs from the rows here fails its archive, and deletes nothing", async () => {
    const id = await finished("garbled");
    const before = rowsOf(id);

    cold.garble = (row) => (row.id === before[1]!.id ? { ...row, record: `${row.record} ` } : row);

    try {
        const report = await archive();

        assert.ok(report.failed.some((each) => each.id === Number(id)));
        assert.equal(app.cold.isCold(id), false);
        assert.deepEqual(rowsOf(id), before);
        assert.deepEqual(
            sql(dataDir, "SELECT * FROM pocket_cold_units WHERE conversation_id = ?", Number(id)),
            [],
        );
    } finally {
        cold.garble = undefined;
    }

    await archive();
    assert.equal(app.cold.isCold(id), true, "archived once the copy is right");
});

const STEPS: ColdStep[] = [
    "copying",
    "uploaded",
    "sealed",
    "verified",
    "deleting",
    "deleted-batch",
    "archived",
];

for (const step of STEPS) {
    test(`a crash at "${step}" leaves every row here, or a sealed and verified cold copy that brings them back`, async () => {
        const name = `crash-${step}`;
        const id = await finished(name);
        const before = rowsOf(id);
        const crashed = join(root, `cold-crash-${step}`);
        let store: FakeCold | undefined;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Hold the archive at the step, and take the files and the cold store as a crash there would leave them.
        onStep = async (at, which) => {
            if (at === step && which === Number(id) && store === undefined) {
                cpSync(dataDir, crashed, {
                    recursive: true,
                    // As a crash leaves the files; the lock is the running app's.
                    filter: (path) => !path.endsWith("-shm") && !path.endsWith("harness.lock"),
                });
                store = cold.clone();
                await held;
            }
        };

        const passing = archive();

        try {
            await until(() => store !== undefined, `the archive at ${step}`, 15_000);
        } finally {
            onStep = undefined;
            release();
        }

        await passing;

        const restarted = await open(crashed, store!);

        try {
            const state = sql<{ state: string }>(
                crashed,
                "SELECT state FROM pocket_cold_units WHERE conversation_id = ?",
                Number(id),
            )[0]?.state;
            const deleting = ["deleting", "deleted-batch", "archived"].includes(step);

            assert.equal(
                restarted.cold.isCold(id),
                deleting,
                "cold only once the copy was verified",
            );

            if (!deleting) {
                // Regression: before the copy was verified, a restart must find every row here.
                assert.deepEqual(rowsOf(id, crashed), before);
                assert.equal(state, undefined, "the cut-off attempt is forgotten");

                return;
            }

            assert.ok(
                store!.units.get(`conv-${id}`)?.sealed,
                "a sealed cold copy stands for the rows",
            );

            if (step !== "archived") {
                // The next pass finishes the deletion a crash cut off.
                const report = await restarted.cold.pass({ ageMs: 0, limit: 0 });

                assert.equal(report.resumed, 1);
                assert.deepEqual(rowsOf(id, crashed), keptOf(before));
            }

            await restarted.conversation(id);
            assert.deepEqual(rowsOf(id, crashed), before, "row for row after the restore");
            assert.equal(restarted.cold.isCold(id), false);
        } finally {
            await restarted.close();
        }
    });
}

test("Durable's reads past warm(): the newest entry and head marker answer from here, a deeper read or a write brings it back", async () => {
    const id = await finished("guarded");
    const before = rowsOf(id);

    await archive();
    assert.equal(app.cold.isCold(id), true);

    const calls: string[] = [];
    const inner = new Proxy({} as Storage, {
        get: (_, name) => async () => {
            calls.push(String(name));

            return { items: [] };
        },
    });
    const guarded = app.cold.guard(inner);

    await guarded.scanEntries({ conversationId: id }, 1, undefined, context);
    await guarded.findLatestHeadMarker(id, undefined, context);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(app.cold.isCold(id), true, "the two rows kept answer these");
    assert.deepEqual(
        calls,
        ["scanEntries", "findLatestHeadMarker"],
        "every call goes through unchanged",
    );

    await guarded.scanEntries({ conversationId: id }, 64, undefined, context);
    await until(() => !app.cold.isCold(id), "the restore a deeper read starts");
    assert.deepEqual(rowsOf(id), before);
});

test("the owner's routes: the state, and a pass; nobody else may", async () => {
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const guest = app.config.addUser("Cold guest", "guest");

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const port = (server.address() as { port: number }).port;
        const call = (path: string, token: string, body?: unknown) =>
            fetch(`http://127.0.0.1:${port}/api/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": "application/json",
                    "x-pocket": "1",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        const status = await call("cold-store", app.config.ownerToken);

        assert.equal(status.status, 200);
        assert.equal(((await status.json()) as { configured: boolean }).configured, true);

        const dry = await call("cold-store/pass", app.config.ownerToken, {
            dryRun: true,
            ageHours: 0,
        });

        assert.equal(dry.status, 200);
        assert.equal(((await dry.json()) as { dryRun: boolean }).dryRun, true);
        assert.equal(
            (await call("cold-store/pass", app.config.ownerToken, { limit: -1 })).status,
            400,
        );
        assert.equal((await call("cold-store", guest.token)).status, 403);
        assert.equal((await call("cold-store/pass", guest.token, { dryRun: true })).status, 403);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
