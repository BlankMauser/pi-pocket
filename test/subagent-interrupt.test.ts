// Interrupt reuses a named subagent's conversation and leaves queued submissions intact.
import {
    cleanUp,
    context,
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
import { join } from "node:path";
import { after, test } from "node:test";
import { type ConversationId, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PlanDoc, SubagentsDoc } from "../src/server/docs.ts";

const model = () =>
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);
        const all = JSON.stringify(request);

        if (all.includes("You are the subagent")) {
            return fauxAssistantMessage([
                fauxText(
                    text.includes("ORIGINAL_CONTEXT") || text.includes("REVISED_CONTEXT")
                        ? "work ".repeat(80_000)
                        : "Finished revised work with the original context.",
                ),
            ]);
        }

        if (role === "user" && text === "SPAWN_WORKER") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "spawn",
                        name: "worker",
                        message: "ORIGINAL_CONTEXT",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && text === "FOLLOW_WORKER") {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "send",
                        name: "worker",
                        message: "REPORTER_FOLLOW",
                        followUp: true,
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        if (role === "user" && (text === "INTERRUPT_WORKER" || text === "FINISH_WORKER")) {
            return fauxAssistantMessage(
                [
                    fauxToolCall("subagent", {
                        action: "interrupt",
                        name: "worker",
                        message: text === "INTERRUPT_WORKER" ? "REVISED_CONTEXT" : "FINAL_REQUEST",
                    }),
                ],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("Noted.")]);
    });

after(() => cleanUp());

async function setup(name: string) {
    const data = join(root, name);
    const app = await openApp(model(), data);

    offerSubagents(app);
    const parent = await newSession(app);

    await say(app, parent, "SPAWN_WORKER");
    let child: ConversationId | undefined;

    await until(async () => {
        child = (await app.harness.snapshot(SubagentsDoc, parent, context))?.agents.worker
            ?.conversationId;

        return child !== undefined && app.isBusy(child);
    }, "the original subagent run");
    const queued = [];

    for (const text of ["FOLLOW_ONE", "FOLLOW_TWO"]) {
        queued.push(
            (
                await app.commands.submit(child!, owner(app), {
                    text,
                    mode: "followUp",
                    requestId: text,
                })
            ).submissionId,
        );
    }

    return { app, parent, child: child!, queued, data };
}

async function revision(on: Awaited<ReturnType<typeof openApp>>, child: ConversationId) {
    await until(async () => {
        const view = await (await on.conversation(child)).context(context);

        return on.isBusy(child) && JSON.stringify(view.messages.at(-1)).includes("REVISED_CONTEXT");
    }, "the revised instructions in the original conversation");
}

test("subagent interrupt keeps its conversation, context and queued submission IDs in order", async () => {
    const { app, parent, child, queued } = await setup("subagent-interrupt");

    try {
        const oldRun = (await app.harness.snapshot(LiveDoc, child, context))?.run?.taskId;

        await say(app, parent, "INTERRUPT_WORKER");
        await revision(app, child);
        assert.equal(
            (await app.harness.snapshot(SubagentsDoc, parent, context))?.agents.worker
                ?.conversationId,
            child,
        );
        const live = await app.harness.snapshot(LiveDoc, child, context);

        assert.notEqual(live?.run?.taskId, oldRun, "the original generation was stopped");
        assert.deepEqual(
            (await app.harness.snapshot(InboxDoc, child, context))?.items.map(({ id }) => id),
            queued,
        );
        const view = await (await app.conversation(child)).context(context);

        assert.match(JSON.stringify(view.messages), /ORIGINAL_CONTEXT/);
        assert.equal(
            view.messages.filter(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("REVISED_CONTEXT"),
            ).length,
            1,
        );

        for (const id of queued) {
            assert.equal((await app.harness.submission(id, context)) !== undefined, true);
            assert.equal(
                (await (await app.harness.submission(id, context))!.status(context)).status,
                "queued",
            );
        }

        await say(app, parent, "FINISH_WORKER");
        await until(async () => {
            const state = await app.harness.snapshot(SubagentsDoc, parent, context);

            return (state?.agents.worker?.reported.length ?? 0) > 0 && !app.isBusy(child);
        }, "the revised subagent answer and report");
        const state = await app.harness.snapshot(SubagentsDoc, parent, context);

        assert.equal(
            new Set(state?.agents.worker?.reported).size,
            state?.agents.worker?.reported.length,
        );
        const final = await (await app.conversation(child)).context(context);
        const text = JSON.stringify(final.messages);

        assert.match(text, /ORIGINAL_CONTEXT/);
        assert.match(text, /FINAL_REQUEST/);
        assert.equal(
            final.messages.filter(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("FOLLOW_ONE"),
            ).length,
            1,
        );
        assert.equal(
            final.messages.filter(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("FOLLOW_TWO"),
            ).length,
            1,
        );
    } finally {
        await app.close();
    }
});

test("a reporter restarted after interrupt delivery sends no duplicate and leaves the new run and queue alone", async () => {
    const setupState = await setup("subagent-interrupt-restart");
    const { parent, child, queued, data } = setupState;
    let app = setupState.app;
    const interrupt = app.interruptSubagent.bind(app);
    let waiting!: () => void;
    const delivered = new Promise<void>((resolve) => {
        waiting = resolve;
    });

    app.interruptSubagent = async (...args) => {
        const submission = await interrupt(...args);

        return {
            ...submission,
            wait: async (callContext) => {
                waiting();

                return new Promise((_, reject) => {
                    callContext.abortSignal?.addEventListener(
                        "abort",
                        () => reject(callContext.abortSignal?.reason),
                        { once: true },
                    );
                });
            },
        };
    };

    try {
        await say(app, parent, "INTERRUPT_WORKER");
        await delivered;
        await revision(app, child);
        await app.close();
        app = await openApp(model(), data);
        await revision(app, child);
        assert.deepEqual(
            (await app.harness.snapshot(InboxDoc, child, context))?.items.map(({ id }) => id),
            queued,
        );
        const view = await (await app.conversation(child)).context(context);

        assert.equal(
            view.messages.filter(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("REVISED_CONTEXT"),
            ).length,
            1,
        );
        const interruptTasks = (await app.harness.inspect(context)).tasks.filter(
            (task) =>
                task.record.kind === "pocket.interrupt" && task.record.conversationId === child,
        );

        assert.equal(interruptTasks.length, 0, "delivery already completed before the restart");
    } finally {
        await app.close();
    }
});

test("a policy change after admission reports refusal to the parent without touching child work or queue", async () => {
    const { app, parent, child, queued } = await setup("subagent-interrupt-refused");
    const interrupt = app.interruptSubagent.bind(app);
    const originalRun = (await app.harness.snapshot(LiveDoc, child, context))?.run?.taskId;

    app.interruptSubagent = async (...args) => {
        await app.harness.commit(async (tx) => {
            (await tx.doc(PlanDoc, child)).on = true;
        }, context);

        return interrupt(...args);
    };

    try {
        await say(app, parent, "INTERRUPT_WORKER");
        await until(async () => {
            const view = await (await app.conversation(parent)).context(context);

            return view.messages.some(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("[subagent worker failed:") &&
                    JSON.stringify(message.content).includes("plan mode"),
            );
        }, "the refused interrupt report");
        assert.equal(
            (await app.harness.snapshot(LiveDoc, child, context))?.run?.taskId,
            originalRun,
        );
        assert.deepEqual(
            (await app.harness.snapshot(InboxDoc, child, context))?.items.map(({ id }) => id),
            queued,
        );
        const state = await app.harness.snapshot(SubagentsDoc, parent, context);

        assert.equal(state?.agents.worker?.failed, true);
        assert.match(state?.agents.worker?.error ?? "", /plan mode/);
    } finally {
        await app.close();
    }
});

test("a reporter-origin follow-up stays queued during the interrupt stop-to-delivery gap", async () => {
    const { app, parent, child, queued } = await setup("subagent-reporter-queue");
    const stop = app.harness.abortTask.bind(app.harness);
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
        reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    try {
        await say(app, parent, "FOLLOW_WORKER");
        await until(
            async () => (await app.harness.snapshot(InboxDoc, child, context))?.items.length === 3,
            "the reporter-origin follow-up",
        );
        const pending = (await app.harness.snapshot(InboxDoc, child, context))!.items.map(
            ({ id }) => id,
        );
        const originalRun = (await app.harness.snapshot(LiveDoc, child, context))!.run!.taskId;

        app.harness.abortTask = async (id, callContext) => {
            const result = await stop(id, callContext);

            if (id === originalRun) {
                await app.harness.waitForTask(id, callContext);
                reached();
                await gate;
            }

            return result;
        };

        await say(app, parent, "INTERRUPT_WORKER");
        await paused;
        // Let the LiveDoc listeners finish reacting to the stopped generation.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal((await app.harness.snapshot(LiveDoc, child, context))?.run, undefined);
        assert.deepEqual(
            (await app.harness.snapshot(InboxDoc, child, context))?.items.map(({ id }) => id),
            pending,
        );
        assert.deepEqual(pending.slice(0, 2), queued);
        assert.equal(
            (await (await app.harness.submission(pending[2]!, context))!.status(context)).status,
            "queued",
        );
        release();
        await revision(app, child);
        assert.deepEqual(
            (await app.harness.snapshot(InboxDoc, child, context))?.items.map(({ id }) => id),
            pending,
        );
    } finally {
        release();
        app.harness.abortTask = stop;
        await app.close();
    }
});
