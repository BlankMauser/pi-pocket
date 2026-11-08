import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ok, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { activityInstance, attributedEnv, attributedTool } from "../src/server/activity.ts";

test("activity identity survives a server restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-activity-"));

    try {
        assert.equal(activityInstance(dir), activityInstance(dir));
    } finally {
        rmSync(dir, { recursive: true });
    }
});

test("concurrent sessions and nested tool calls keep distinct execution identities", async () => {
    const calls: { command: string; env: Record<string, string> }[] = [];
    const base = {
        exec: async (command: string, options: { env: Record<string, string> }) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            calls.push({ command, env: options.env });

            return ok({ exitCode: 0 });
        },
    } as unknown as ExecutionEnv;
    const capabilities = async () => ({
        node: "C:\\Program Files\\Node\\node.exe",
        runner: "C:\\Pocket\\activity-run.mjs",
    });
    const one = attributedEnv(
        base,
        { POCKET_INSTANCE_ID: "instance", POCKET_CONVERSATION_ID: "1" },
        capabilities,
    );
    const two = attributedEnv(
        base,
        { POCKET_INSTANCE_ID: "instance", POCKET_CONVERSATION_ID: "2" },
        capabilities,
    );
    const tool = attributedTool(
        defineTool({
            name: "test_exec",
            description: "fixture",
            parameters: obj({}),
            execute: async (_args, api, context) => {
                await api.env!.exec("printf '%s' '$HOME;do-not-evaluate'", undefined, context);

                return { output: [] };
            },
        }),
    );
    const api = (env: ExecutionEnv, callId: string) =>
        ({ env, callId }) as Parameters<typeof tool.execute>[1];

    await Promise.all([
        tool.execute({}, api(one, "call/child"), BACKGROUND_CONTEXT),
        tool.execute({}, api(two, "another"), BACKGROUND_CONTEXT),
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.env.POCKET_CONVERSATION_ID).sort(), ["1", "2"]);
    assert.equal(new Set(calls.map((c) => c.env.POCKET_EXECUTION_ID)).size, 2);
    assert.deepEqual(calls.map((c) => c.env.POCKET_TOOL_CALL_ID).sort(), ["another", "call/child"]);
    assert.ok(
        calls.every(
            (c) => c.command === "'C:/Program Files/Node/node.exe' 'C:/Pocket/activity-run.mjs'",
        ),
    );
    assert.ok(
        calls.every(
            (c) =>
                JSON.parse(c.env.POCKET_ACTIVITY_COMMAND!) ===
                "printf '%s' '$HOME;do-not-evaluate'",
        ),
    );
});

test("activity wrapping preserves 0.27 command environment injection and secret redaction", async () => {
    const { wrapEnv, CommandEnvs, HiddenValues } = await import("../src/server/hidden.ts");
    const envs = new CommandEnvs(() => {});
    const hidden = new HiddenValues();
    const secret = "synthetic-hidden-value";

    hidden.add({ value: secret, label: "fixture" });
    envs.add((run) => {
        assert.deepEqual(run.command, ["echo", "$TEST_SECRET"]);
        assert.equal(run.conversationId, 42);

        return { TEST_SECRET: secret };
    });
    let output = "";
    const base = {
        exec: async (
            _command: unknown,
            options: {
                env: Record<string, string>;
                onOutput: (
                    text: string,
                    context: typeof BACKGROUND_CONTEXT,
                    info: { stream: "stdout" },
                ) => void;
            },
        ) => {
            assert.equal(options.env.TEST_SECRET, secret);
            assert.deepEqual(JSON.parse(options.env.POCKET_ACTIVITY_COMMAND!), [
                "echo",
                "$TEST_SECRET",
            ]);
            assert.equal(options.env.POCKET_CONVERSATION_ID, "42");
            options.onOutput(secret.slice(0, 8), BACKGROUND_CONTEXT, { stream: "stdout" });
            options.onOutput(secret.slice(8) + "\n", BACKGROUND_CONTEXT, { stream: "stdout" });

            return ok({ exitCode: 0 });
        },
    } as unknown as ExecutionEnv;
    const attributed = attributedEnv(base, { POCKET_CONVERSATION_ID: "42" }, async () => ({
        node: "/node",
        runner: "/runner",
    }));
    const wrapped = wrapEnv(attributed, 42, "/work", envs, hidden);

    await wrapped.exec(
        ["echo", "$TEST_SECRET"],
        {
            onOutput: (text) => {
                output += text;
            },
        },
        BACKGROUND_CONTEXT,
    );
    assert.equal(output, "[fixture]\n");
});
