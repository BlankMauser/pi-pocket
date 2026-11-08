// Team controls use the linked-session policy and durable receipts, including after a cut-off stop.
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import createAgentTeams from "../src/server/extensions/agent-teams.ts";
import type { PocketHost } from "../src/server/host.ts";

let app: Awaited<ReturnType<typeof openApp>>;

before(async () => {
    app = await openApp(
        scriptedModel((request) => {
            const { text } = lastText(request as never);

            return fauxAssistantMessage([
                fauxText(text.includes("STREAM_CONTROL") ? "word ".repeat(80_000) : "Done."),
            ]);
        }),
        join(root, "team-controls"),
    );
});
after(async () => {
    await app?.close();
    cleanUp();
});

function team() {
    return createAgentTeams({
        linkedSessions: app.linkedSessions,
        text: { quoted: JSON.stringify },
        thinkingLevels: ["off"],
    } as unknown as PocketHost).tools![0]!;
}

const call = (id: ConversationId, args: object, callId: string = crypto.randomUUID()) =>
    team().execute(args, { conversationId: id, taskId: 900, callId } as never, context);

async function source() {
    const id = await newSession(app);

    await say(app, id, "Hello.");

    return id;
}

async function start(id: ConversationId, message = "A task.") {
    const linked = await app.linkedSessions.start(id, { message }, crypto.randomUUID());

    await until(
        () => app.isBusy(linked.session) === message.includes("STREAM_CONTROL"),
        "the linked run state",
    );

    return linked;
}

async function streaming(id: ConversationId) {
    await app.commands.submit(id, owner(app), {
        text: "STREAM_CONTROL",
        requestId: crypto.randomUUID(),
    });
    await until(() => app.isBusy(id), "the next linked run");
}

test("team stop needs only an address, and replay never stops a newer run", async () => {
    const id = await source();
    const { session, address } = await start(id, "STREAM_CONTROL");
    const args = { action: "stop", to: address };
    const result = await call(id, args, "stop-once");

    assert.match(JSON.stringify(result.output), /Stopped linked session/);
    await until(() => !app.isBusy(session), "the stop");
    await streaming(session);
    assert.deepEqual(await call(id, args, "stop-once"), result);
    assert.equal(
        app.isBusy(session),
        true,
        "replaying the completed receipt leaves newer work running",
    );
    await (await app.conversation(session)).abort(context);
});

test("a stop cut off after abort preserves the next run when the tool is replayed", async () => {
    const id = await source();
    const { session, address } = await start(id, "STREAM_CONTROL");
    const finish = app.commands.finishStop.bind(app.commands);

    app.commands.finishStop = async (...args) => {
        await finish(...args);

        throw new Error("cut off after the old run stopped");
    };

    try {
        await assert.rejects(
            call(id, { action: "stop", to: address }, "cut-after-stop"),
            /could not be confirmed/,
        );
    } finally {
        app.commands.finishStop = finish;
    }

    await until(() => !app.isBusy(session), "the old run to stop");
    await streaming(session);
    await call(id, { action: "stop", to: address }, "cut-after-stop");
    assert.equal(app.isBusy(session), true, "a pending receipt remains bound to its original run");
    await (await app.conversation(session)).abort(context);
});

test("team archive needs no message, restores on request, and replay keeps the original receipt", async () => {
    const id = await source();
    const { session, address } = await start(id);
    const args = { action: "archive", to: address };
    const first = await call(id, args, "archive-once");

    assert.equal(app.sessionMeta(session)?.archived, true);
    assert.match(JSON.stringify(first.output), /does not stop/);
    await app.commands.updateSession(session, owner(app), { archived: false });
    assert.deepEqual(await call(id, args, "archive-once"), first);
    assert.equal(app.sessionMeta(session)?.archived, false, "replay does not archive it again");
    await call(id, args, "archive-again");
    await call(id, { ...args, archived: false }, "restore");
    assert.equal(app.sessionMeta(session)?.archived, false);
});

test("team controls refuse foreign sessions and policy failures without exposing target details", async () => {
    const id = await source();
    const other = await source();
    const target = await start(id);
    const foreign = await start(other);

    for (const action of ["stop", "archive"]) {
        await assert.rejects(call(id, { action, to: foreign.address }), /could not be confirmed/);
        await assert.rejects(call(id, { action }), /needs an address/);
    }

    await app.commands.setPlan(id, owner(app), true);

    for (const action of ["stop", "archive"]) {
        await assert.rejects(call(id, { action, to: target.address }), /could not be confirmed/);
    }

    assert.notEqual(app.sessionMeta(target.session)?.archived, true);
    assert.notEqual(app.sessionMeta(foreign.session)?.archived, true);
});

test("first team stop cannot abort a newer generation or withdraw its new inputs before saving its receipt", async () => {
    const id = await source();
    const { session, address } = await start(id, "STREAM_CONTROL");
    const oldInput = await app.commands.submit(session, owner(app), {
        text: "old queued work at Stop admission",
        mode: "followUp",
        requestId: "old-at-stop",
    });
    const finish = app.commands.finishStop.bind(app.commands);
    let newInput: number | undefined;
    let finished = 0;

    app.commands.finishStop = async (...args) => {
        await finish(...args);
        finished++;
        await streaming(session);
        newInput = Number(
            (
                await app.commands.submit(session, owner(app), {
                    text: "new queued work after the original stop",
                    mode: "followUp",
                    requestId: "new-after-stop",
                })
            ).submissionId,
        );
    };

    try {
        await call(id, { action: "stop", to: address }, "stop-with-next-run");
    } finally {
        app.commands.finishStop = finish;
    }

    assert.equal(finished, 1, "the original stop completed before newer work was admitted");
    assert.equal(
        (await (await app.harness.submission(oldInput.submissionId, context))!.status(context))
            .status,
        "unanswered",
        "Stop withdrew only the input present at admission",
    );
    assert.equal(app.isBusy(session), true, "the first stop cannot cross into the next generation");
    assert.deepEqual(
        (await app.harness.snapshot(InboxDoc, session, context))?.items.map(({ id }) => Number(id)),
        [newInput],
    );
    await call(id, { action: "stop", to: address }, "stop-with-next-run");
    assert.equal(app.isBusy(session), true, "replay also leaves the new generation running");
    assert.deepEqual(
        (await app.harness.snapshot(InboxDoc, session, context))?.items.map(({ id }) => Number(id)),
        [newInput],
        "replay does not withdraw inputs admitted after Stop",
    );
    await (await app.conversation(session)).abort(context);
});
