// Queue controls exercise actual durable transactions, generations and restart recovery with an isolated model.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    offerSubagents,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { queueInterrupt } from "../src/server/resend.ts";

const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    if (text.includes("spawn queue helper") && role !== "toolResult") {
        return fauxAssistantMessage(
            [
                fauxToolCall("subagent", {
                    action: "spawn",
                    name: "queued-helper",
                    message: "hold child",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([
        fauxText(
            text.includes("hold") || role === "toolResult"
                ? "holding ".repeat(8000)
                : `echo: ${text}`,
        ),
    ]);
});
let app: App;
const inbox = async (id: ConversationId) =>
    (await app.harness.snapshot(InboxDoc, id, context))!.items;
const send = (id: ConversationId, text: string, requestId = text) =>
    app.commands.submit(id, owner(app), { text, requestId });

const busy = async (id: ConversationId) => {
    await send(id, "hold original");
    await until(() => app.isBusy(id), "a streaming generation");
};

before(async () => {
    app = await openApp(model);
});
after(async () => {
    await app.close();
    cleanUp();
});

test("bulk steer is one atomic selection and keeps queue order and unrelated modes", async () => {
    const id = await newSession(app);

    await busy(id);
    const first = await send(id, "first");
    const middle = await send(id, "middle");
    const last = await send(id, "last");

    await app.commands.moveQueuedMany(
        id,
        owner(app),
        [Number(last.submissionId), Number(first.submissionId)],
        "steer",
    );
    assert.deepEqual(
        (await inbox(id)).map((item) => [Number(item.id), item.mode]),
        [
            [Number(first.submissionId), "steer"],
            [Number(middle.submissionId), "followUp"],
            [Number(last.submissionId), "steer"],
        ],
    );
    await assert.rejects(
        app.commands.moveQueuedMany(id, owner(app), [Number(first.submissionId), 999999], "steer"),
    );
    assert.equal((await inbox(id))[1]!.mode, "followUp");
    await app.commands.abort(id, owner(app));
});

test("bulk selection rejects another person's input without partially moving mine", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Queue Guest", "guest").user;

    try {
        await busy(id);
        const mine = await send(id, "mine");
        const theirs = await app.commands.submit(id, guest, {
            text: "theirs",
            requestId: "theirs",
        });

        await assert.rejects(
            app.commands.moveQueuedMany(
                id,
                owner(app),
                [Number(mine.submissionId), Number(theirs.submissionId)],
                "interrupt",
            ),
            /Only its sender/,
        );
        assert.deepEqual(
            (await inbox(id)).map((item) => item.mode),
            ["followUp", "followUp"],
        );

        for (const invalid of [
            [],
            [Number(mine.submissionId), Number(mine.submissionId)],
            ["1"],
            [0],
            null,
        ]) {
            await assert.rejects(app.commands.moveQueuedMany(id, owner(app), invalid, "steer"));
        }
    } finally {
        await app.commands.abort(id, owner(app));
        app.config.removeUser(guest.id);
    }
});

test("bulk interrupt sends selected contents in queue order and preserves original other/report receipts", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Report Guest", "guest").user;

    try {
        await busy(id);
        const first = await send(id, "hold selected first");
        const theirs = await app.commands.submit(id, guest, {
            text: "guest waiting",
            mode: "steer",
            requestId: "guest-keep",
        });
        const last = await send(id, "selected last");
        const report = await (
            await app.conversation(id)
        ).submit(
            {
                type: "input",
                content: "[report] preserve receipt",
                whenBusy: "followUp",
                requestId: "courier-original",
            },
            context,
        );
        const before = (await inbox(id)).filter(
            (item) => item.id === theirs.submissionId || item.id === report.id,
        );

        await app.commands.moveQueuedMany(
            id,
            owner(app),
            [Number(last.submissionId), Number(first.submissionId)],
            "interrupt",
        );
        await until(
            async () =>
                (await modelTexts(app, id)).some(
                    (text) => text.includes("selected first") && text.includes("selected last"),
                ),
            "the selected interrupt instruction",
        );
        assert.deepEqual(await inbox(id), before);
        assert.equal(
            (await (await app.harness.submission(theirs.submissionId, context))!.status(context))
                .status,
            "queued",
        );
        assert.equal((await report.status(context)).status, "queued");
        const messages = await modelTexts(app, id);
        const selected = messages.find(
            (text) => text.includes("selected first") && text.includes("selected last"),
        )!;

        assert.ok(selected.indexOf("selected first") < selected.indexOf("selected last"));
    } finally {
        await app.commands.abort(id, owner(app));
        app.config.removeUser(guest.id);
    }
});

test("composer interrupt preserves own queue and a working persistent subagent's queue", async () => {
    await offerSubagents(app);
    const id = await newSession(app);

    await send(id, "spawn queue helper");
    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, id, context))?.agents["queued-helper"]
            ?.conversationId;

        return child !== undefined && app.isBusy(child) && app.isBusy(id);
    }, "the parent and persistent child to run");
    const rootQueued = await send(id, "root waiting");
    const childQueued = await send(child!, "child waiting");
    const rootBefore = await inbox(id);
    const childBefore = await inbox(child!);

    await app.commands.submit(id, owner(app), {
        text: "hold replacement",
        mode: "interrupt",
        requestId: "parent-interrupt",
    });
    assert.deepEqual(await inbox(id), rootBefore);
    assert.deepEqual(await inbox(child!), childBefore);
    assert.ok((await inbox(id)).some((item) => item.id === rootQueued.submissionId));
    assert.ok((await inbox(child!)).some((item) => item.id === childQueued.submissionId));
    assert.ok(app.isBusy(child!), "interrupting the parent did not stop its persistent child");
    await app.commands.abort(id, owner(app));
    await app.commands.abort(child!, owner(app));
});

test("concurrent duplicate interrupts capture one generation and deliver exactly once", async () => {
    const id = await newSession(app);

    await busy(id);
    const kept = await send(id, "kept across duplicates");
    const request = {
        text: "hold duplicate replacement",
        mode: "interrupt" as const,
        requestId: "same-interrupt",
    };
    const [one, two] = await Promise.all([
        app.commands.submit(id, owner(app), request),
        app.commands.submit(id, owner(app), request),
    ]);

    assert.equal(one.submissionId, two.submissionId);
    assert.deepEqual(
        (await inbox(id)).map((item) => item.id),
        [kept.submissionId],
    );
    const run = (await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId;

    await app.commands.submit(id, owner(app), request);
    assert.equal((await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId, run);
    await app.commands.abort(id, owner(app));
});

test("a durable interrupt admitted before restart preserves queued IDs and sends once after reopening", async () => {
    const dataDir = join(root, "queue-restart");
    let other = await openApp(model, dataDir);

    try {
        const id = await newSession(other);

        await other.commands.submit(id, owner(other), {
            text: "hold before restart",
            requestId: "restart-run",
        });
        await until(() => other.isBusy(id), "the restart fixture run");
        const kept = await other.commands.submit(id, owner(other), {
            text: "restart kept",
            requestId: "restart-kept",
        });
        const request = `u:${owner(other).id}:restart-interrupt`;
        const created = await other.harness.commit(
            (tx) =>
                queueInterrupt(
                    tx,
                    id,
                    { content: "hold restored interrupt", requestId: request },
                    other.commands.interruptTask,
                ),
            context,
        );

        await other.close();
        other = await openApp(model, dataDir);

        if (created !== undefined) {
            await other.harness.waitForTask(created, context);
        }

        const again = await other.harness.commit(
            (tx) =>
                queueInterrupt(
                    tx,
                    id,
                    { content: "hold restored interrupt", requestId: request },
                    other.commands.interruptTask,
                ),
            context,
        );

        assert.equal(again, undefined, "the persisted delivered submission deduplicates a retry");
        assert.deepEqual(
            (await other.harness.snapshot(InboxDoc, id, context))!.items.map((item) => item.id),
            [kept.submissionId],
        );
        await other.commands.abort(id, owner(other));
    } finally {
        await other.close();
    }
});

test("explicit Stop cancels an admitted interrupt before delivery without resurrecting the run", async () => {
    const id = await newSession(app);

    await busy(id);
    let entered!: () => void;
    const stopping = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const original = app.harness.abortTask;
    let first = true;

    app.harness.abortTask = async (id, callContext) => {
        if (!first) {
            return original.call(app.harness, id, callContext);
        }

        first = false;
        entered();
        await new Promise<never>((_resolve, reject) => {
            const signal = callContext.abortSignal!;

            if (signal.aborted) {
                reject(signal.reason);

                return;
            }

            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });

        return "marked";
    };

    try {
        const task = await app.harness.commit(
            (tx) =>
                queueInterrupt(
                    tx,
                    id,
                    {
                        content: "must never be sent after stop",
                        requestId: "stop-cancels-interrupt",
                    },
                    app.commands.interruptTask,
                ),
            context,
        );

        assert.notEqual(task, undefined);
        await stopping;
        await app.commands.abort(id, owner(app));
        const stopped = await app.harness.waitForTask(task!, context);

        assert.equal(stopped.state.status, "terminal");

        if (stopped.state.status === "terminal") {
            assert.equal(stopped.state.outcome.status, "aborted");
        }

        await until(() => !app.isBusy(id), "the stopped generation");
        const submission = await app.harness.commit(
            (tx) => tx.submissionByRequest(id, "stop-cancels-interrupt"),
            context,
        );

        assert.equal(submission, undefined);
    } finally {
        app.harness.abortTask = original;
    }
});

test("the bulk HTTP route validates its contract and enforces viewer restrictions", async () => {
    const { createServer } = await import("node:http");
    const { createHandler } = await import("../src/server/http.ts");
    const id = await newSession(app);

    await busy(id);
    const queued = await send(id, "HTTP queued");
    const viewer = app.config.addUser("Queue Viewer", "viewer");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c/${id}/queue`;
    const call = (token: string, body: unknown) =>
        fetch(url, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

    try {
        assert.equal(
            (await call(viewer.token, { action: "steer", ids: [Number(queued.submissionId)] }))
                .status,
            403,
        );
        assert.equal(
            (
                await call(app.config.ownerToken, {
                    action: "withdraw",
                    ids: [Number(queued.submissionId)],
                })
            ).status,
            400,
        );
        const result = await call(app.config.ownerToken, {
            action: "steer",
            ids: [Number(queued.submissionId)],
        });

        assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), { ok: true });
        assert.equal((await inbox(id))[0]!.mode, "steer");
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        app.config.removeUser(viewer.user.id);
        await app.commands.abort(id, owner(app));
    }
});

test("bulk steer wakes an idle queue in its existing conversation while other inputs keep their receipts", async () => {
    const id = await newSession(app);

    await busy(id);
    const first = await send(id, "hold selected idle first");
    const kept = await send(id, "unselected idle queued");
    const last = await send(id, "selected idle last");
    const run = (await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId;

    await app.harness.abortTask(run, context);
    await app.harness.waitForTask(run, context);
    assert.equal(app.isBusy(id), false);
    await app.commands.moveQueuedMany(
        id,
        owner(app),
        [Number(last.submissionId), Number(first.submissionId)],
        "steer",
    );
    await until(() => app.isBusy(id), "the selected idle queue to resume");
    assert.deepEqual(
        (await inbox(id)).map((item) => item.id),
        [kept.submissionId],
    );
    const all = await modelTexts(app, id);

    assert.ok(all.some((text) => text.includes("selected idle first")));
    assert.ok(all.some((text) => text.includes("selected idle last")));
    assert.equal(
        (await (await app.harness.submission(kept.submissionId, context))!.status(context)).status,
        "queued",
    );
    await app.commands.abort(id, owner(app));
});

test("bulk controls reject a reached spend limit before changing or removing any selected input", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Budget Queue Guest", "guest").user;

    try {
        await busy(id);
        const queued = await app.commands.submit(id, guest, {
            text: "budget queued",
            requestId: "budget-queued",
        });
        const before = await inbox(id);

        app.config.updateUser(guest.id, { budget: 0 });

        for (const mode of ["steer", "interrupt"]) {
            await assert.rejects(
                app.commands.moveQueuedMany(id, guest, [Number(queued.submissionId)], mode),
                /spend limit/,
            );
            assert.deepEqual(await inbox(id), before);
        }
    } finally {
        await app.commands.abort(id, owner(app));
        app.config.removeUser(guest.id);
    }
});

test("a captured Stop receipt never aborts a replacement generation or withdraws its new queue", async () => {
    const id = await newSession(app);

    await busy(id);
    const oldQueued = await send(id, "old queue is withdrawn once");
    const receipt = await app.harness.commit((tx) => app.commands.captureStop(tx, id), context);

    await app.commands.finishStop(receipt);
    assert.equal(
        (await (await app.harness.submission(oldQueued.submissionId, context))!.status(context))
            .status,
        "unanswered",
    );
    await send(id, "hold newer generation", "newer-generation");
    await until(() => app.isBusy(id), "the newer generation");
    const run = (await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId;
    const kept = await send(id, "new queue is kept", "newer-queued");

    await app.commands.finishStop(receipt);
    assert.equal((await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId, run);
    assert.deepEqual(
        (await inbox(id)).map((item) => item.id),
        [kept.submissionId],
    );
    await app.commands.abort(id, owner(app));
});

test("Stop cancels legacy background interrupts and never restores their held inputs", async () => {
    const id = await newSession(app);

    await busy(id);
    const run = (await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId;
    const original = app.harness.abortTask;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let first = true;

    app.harness.abortTask = async (task, callContext) => {
        if (task === run && first) {
            first = false;
            enter();
            // Deliberately ignores cancellation until released, like a legacy task cut off in stopRun.
            await gate;
        }

        return original.call(app.harness, task, callContext);
    };

    try {
        const legacy = await app.harness.commit(
            (tx) =>
                tx.createTask(
                    app.commands.interruptTask,
                    {
                        content: "legacy instruction must not resurrect the run",
                        requestId: "legacy-stop-instruction",
                        run: Number(run),
                        others: [
                            {
                                content: "legacy held input must not return",
                                mode: "followUp",
                                requestId: "legacy-stop-held",
                            },
                        ],
                    },
                    { ownership: { kind: "conversation" }, background: true, conversationId: id },
                ),
            context,
        );

        await entered;
        await app.commands.abort(id, owner(app));
        await until(
            () => !app.isBusy(id),
            "the old run to stop while the background legacy task is paused",
        );
        release();
        await app.harness.waitForTask(legacy, context);
        assert.equal(app.isBusy(id), false);
        assert.deepEqual(await inbox(id), []);

        for (const request of ["legacy-stop-instruction", "legacy-stop-held"]) {
            assert.equal(
                await app.harness.commit((tx) => tx.submissionByRequest(id, request), context),
                undefined,
            );
        }
    } finally {
        release();
        app.harness.abortTask = original;
    }
});

test("the Stop admission fence blocks legacy delivery even before task cancellation finishes", async () => {
    const id = await newSession(app);

    await busy(id);
    const run = (await app.harness.snapshot(LiveDoc, id, context))!.run!.taskId;
    const original = app.harness.abortTask;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    app.harness.abortTask = async (task, callContext) => {
        enter();
        await gate;

        return original.call(app.harness, task, callContext);
    };

    try {
        const legacy = await app.harness.commit(
            (tx) =>
                tx.createTask(
                    app.commands.interruptTask,
                    {
                        content: "legacy fence blocked",
                        requestId: "legacy-fence-blocked",
                        run: Number(run),
                    },
                    { ownership: { kind: "conversation" }, background: true, conversationId: id },
                ),
            context,
        );

        await entered;
        const receipt = await app.harness.commit((tx) => app.commands.captureStop(tx, id), context);

        release();
        await app.harness.waitForTask(legacy, context);
        assert.equal(
            await app.harness.commit(
                (tx) => tx.submissionByRequest(id, "legacy-fence-blocked"),
                context,
            ),
            undefined,
        );
        app.harness.abortTask = original;
        await app.commands.finishStop(receipt);
    } finally {
        release();
        app.harness.abortTask = original;
    }
});

test("Steer all accepts more than 128 own pending inputs in one atomic selection", async () => {
    const id = await newSession(app);

    await busy(id);
    const sent = await Promise.all(
        Array.from({ length: 129 }, (_, at) => send(id, `large queue ${at}`, `large-${at}`)),
    );
    const before = await inbox(id);

    assert.equal(before.length, 129);
    await app.commands.moveQueuedMany(
        id,
        owner(app),
        sent.map((item) => Number(item.submissionId)).reverse(),
        "steer",
    );
    const after = await inbox(id);

    assert.deepEqual(
        after.map((item) => item.id),
        before.map((item) => item.id),
    );
    assert.ok(after.every((item) => item.mode === "steer"));
    await app.commands.abort(id, owner(app));
});
