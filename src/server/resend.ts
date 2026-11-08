/**
 * Sending a message again: it goes out in a new fork, made in one commit with a task that sends it. A restart before
 * the message went out cannot leave the fork without it. Whoever sends it again sends it right away as well; with one
 * request id per fork, it goes out once either way.
 */
import { copyJson, type Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
    defineTask,
    defineDoc,
    InboxDoc,
    LiveDoc,
    type ConversationId,
    type Cursor,
    type Task,
    type TaskId,
    type Tx,
    type EntryId,
    type InputEntry,
    type UserInput,
} from "@earendil-works/pi-durable";
import { CONTEXT_BLOCK, FILE_BLOCK } from "./entry-format.ts";
import { ownRequest } from "./requests.ts";

/** What a fork sends: the text, by whom, and the message whose images go along, when the model takes images. */
export type Resend = { text: string; by: string; images?: { entry: EntryId } };

/** The request id of the message a fork was made to send. */
export const resendRequest = (resend: Resend) => ownRequest(resend.by, "resend");

/**
 * A message's text and images, from a `pi.user` entry's model message. Files sent along with it (`<file>` parts) are
 * left out: sent again, the message mentions them as before.
 */
export function userContent(model: unknown): { text: string; images: ImageContent[] } {
    const content = (model as { content?: unknown } | undefined)?.content;

    if (typeof content === "string") {
        return { text: content, images: [] };
    }

    const parts = Array.isArray(content) ? (content as (TextContent | ImageContent)[]) : [];

    return {
        text: parts
            .flatMap((part, index) =>
                part.type === "text" &&
                (index === 0 ||
                    (!part.text.startsWith(FILE_BLOCK) && !part.text.startsWith(CONTEXT_BLOCK)))
                    ? [part.text]
                    : [],
            )
            .join("\n"),
        images: parts.filter((part): part is ImageContent => part.type === "image"),
    };
}

/** The message to send: its text, with the images of the message it repeats. */
export const resendContent = (text: string, images: readonly ImageContent[]) =>
    images.length === 0 ? text : [{ type: "text" as const, text }, ...images];

const finished = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** Sends a fork's message, with the original's images read from where it was sent first. */
export const ResendTask = defineTask<Resend, { phase: "send" }, null>({
    name: "pocket.resend",
    version: 1,
    initial: () => ({ phase: "send" }),
    phases: {
        send: async (task, runtime, context) => {
            const resend = task.input;
            let images: ImageContent[] = [];
            const original = resend.images?.entry;

            if (original !== undefined) {
                // A commit that changes nothing, to read the original message.
                await runtime.commit(async (tx) => {
                    images = userContent((await tx.entry(original))?.model?.[0]).images;

                    return undefined;
                }, context);
            }

            const conversation = await runtime.conversation(runtime.conversationId, context);

            await conversation?.submit(
                {
                    type: "input",
                    content: resendContent(resend.text, images),
                    requestId: resendRequest(resend),
                },
                context,
            );
            await runtime.commit(() => finished, context);
        },
    },
    abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Stop's admission counter fences pending interrupts, including older background tasks without a counter. */
export const QueueControlDoc = defineDoc<{ stop: number }>({
    kind: "pocket.queue-control",
    version: 1,
    checkpointWhen: () => true,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ stop: 0 }),
});

/** Exact task identities present when Stop was admitted; replay only joins these, never newer work. */
export type StopReceipt = { tasks: number[] };

/** A queued message that stays queued across an Interrupt: sent again, in its place, under its own request id. */
export type Requeue = {
    content: UserInput;
    mode: "steer" | "followUp";
    requestId: string;
    entry?: InputEntry;
};

/**
 * A queued message moved to Interrupt: what it says, the request id it goes out with, the run it stops, and the other
 * queued messages, in their order, which the stop would withdraw and which are queued again after it.
 */
export type Interrupt = {
    content: UserInput;
    requestId: string;
    /** The run that was going when the message was moved: only that run is stopped, never one that came after. */
    run?: number;
    /** Absent in legacy persisted tasks: the initial stop counter was zero. */
    stopAt?: number;
    others?: Requeue[];
};

/**
 * Admit one durable interrupt on the transaction line. The generation is captured once, and a retry joins the same
 * task or finds the delivered submission. No queued submission is withdrawn, including reports and child work.
 */
export async function queueInterrupt(
    tx: Tx,
    id: ConversationId,
    input: Pick<Interrupt, "content" | "requestId">,
    definition: Task<Interrupt, { phase: "send" }, null, object>,
): Promise<TaskId | undefined> {
    if ((await tx.submissionByRequest(id, input.requestId)) !== undefined) {
        return undefined;
    }

    let cursor: Cursor | undefined;

    do {
        const page = await tx.scanTasks(
            { conversationId: id, kind: "pocket.interrupt" },
            100,
            cursor,
        );
        const existing = page.items.find(
            (task) => (task.input as Interrupt).requestId === input.requestId,
        );

        if (existing !== undefined) {
            if (
                existing.state.status === "terminal" &&
                existing.state.outcome.status !== "completed"
            ) {
                throw new Error(
                    "The interrupt could not be delivered; its durable task needs recovery.",
                );
            }

            return existing.id;
        }

        cursor = page.next;
    } while (cursor !== undefined);

    const live = await tx.doc(LiveDoc, id);
    const stopAt = (await tx.doc(QueueControlDoc, id)).stop;
    const run = live.run === undefined ? undefined : Number(live.run.taskId);

    return tx.createTask(
        definition,
        { ...input, stopAt, ...(run === undefined ? {} : { run }) },
        { ownership: { kind: "conversation" }, background: false, conversationId: id },
    );
}

/** Stops only the captured generation; persistent subagent anchors are background work outside this generation. */
export type StopRun = (run: number, context: Context) => Promise<void>;

/**
 * Stop the captured generation, then admit the instruction ahead of pending inputs in one commit. Temporarily
 * holding the inbox only inside that commit keeps original submission IDs, senders, modes and report receipts.
 * Admission and restoration are atomic: a crash can expose neither an empty queue nor half a delivered interrupt.
 * `others` remains readable for durable tasks written by older Pocket versions.
 */
export const interruptTask = (stopRun: StopRun) =>
    defineTask<Interrupt, { phase: "send" }, null>({
        name: "pocket.interrupt",
        version: 1,
        initial: () => ({ phase: "send" }),
        phases: {
            send: async (task, runtime, context) => {
                const { content, requestId, run, others, stopAt = 0 } = task.input;
                const id = runtime.conversationId;
                let sent = false;
                let cancelled = false;

                await runtime.commit(async (tx) => {
                    sent = (await tx.submissionByRequest(id, requestId)) !== undefined;
                    cancelled = (await tx.doc(QueueControlDoc, id)).stop !== stopAt;

                    return cancelled
                        ? { status: "terminal", outcome: { status: "aborted" } }
                        : undefined;
                }, context);

                if (cancelled) {
                    return;
                }

                const conversation = await runtime.conversation(id, context);

                if (conversation === undefined) {
                    throw new Error("The interrupt conversation is missing.");
                }

                if (!sent) {
                    if (run !== undefined) {
                        await stopRun(run, context);
                    }

                    await runtime.commit(async (tx) => {
                        cancelled = (await tx.doc(QueueControlDoc, id)).stop !== stopAt;

                        if (cancelled) {
                            return { status: "terminal", outcome: { status: "aborted" } };
                        }

                        if ((await tx.submissionByRequest(id, requestId)) !== undefined) {
                            return undefined;
                        }

                        const inbox = await tx.doc(InboxDoc, id);
                        const waiting = copyJson(inbox.items) as typeof inbox.items;

                        // An idle submission otherwise runs the older queue first. Keep it on this transaction only.
                        inbox.items = [];
                        await conversation.submit(tx, { type: "input", content, requestId });
                        inbox.items.push(...waiting);

                        return undefined;
                    }, context);
                }

                if (cancelled) {
                    return;
                }

                // Legacy held messages obey the same Stop fence; none may be restored after a later Stop.
                for (const other of others ?? []) {
                    await runtime.commit(async (tx) => {
                        cancelled = (await tx.doc(QueueControlDoc, id)).stop !== stopAt;

                        if (cancelled) {
                            return { status: "terminal", outcome: { status: "aborted" } };
                        }

                        await conversation.submit(tx, {
                            type: "input",
                            content: other.content,
                            whenBusy: other.mode,
                            requestId: other.requestId,
                            ...(other.entry === undefined ? {} : { entry: other.entry }),
                        });

                        return undefined;
                    }, context);

                    if (cancelled) {
                        return;
                    }
                }

                await runtime.commit(() => finished, context);
            },
        },
        abort: (_task, runtime, context) =>
            runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
