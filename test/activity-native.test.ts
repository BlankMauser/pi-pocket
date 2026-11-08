import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { attributedEnv } from "../src/server/activity.ts";

const worker = process.env.POCKET_ACTIVITY_TEST_WORKER;
const daemon = process.env.POCKET_ACTIVITY_TEST_DAEMON;

test(
    "native pi-env preserves command output and attributes a running command",
    { skip: !worker || !daemon },
    async () => {
        const root = mkdtempSync(join(tmpdir(), "pocket-native-activity-"));
        const connection = new Connection({ command: [daemon!] });
        const { snapshot } = await import(join(worker!, "activity.mjs"));

        try {
            const env = attributedEnv(
                new RemoteExecutionEnv({ connection, id: "fixture", cwd: root }),
                {
                    POCKET_INSTANCE_ID: "native-fixture",
                    POCKET_CONVERSATION_ID: "42",
                    POCKET_TOOL_CALL_ID: "native/tool",
                },
                async () => ({ node: process.execPath, runner: join(worker!, "activity-run.mjs") }),
            );
            let output = "";
            const running = env.exec(
                "printf 'native-ready\\n'; sleep 2; exit 7",
                {
                    env: { POCKET_ACTIVITY_STATE: root },
                    onOutput: (text) => {
                        output += text;
                    },
                },
                BACKGROUND_CONTEXT,
            );
            let found;

            for (let i = 0; i < 100; i++) {
                found = (
                    await snapshot({ root, instanceId: "native-fixture", conversationIds: ["42"] })
                ).executions[0];

                if (found?.processes.length >= 2) {
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            assert.equal(found?.toolCallId, "native/tool");
            assert.ok(found.processes.length >= 2);
            const result = await running;

            assert.equal(result.ok, true);
            assert.equal(output, "native-ready\n");

            if (result.ok) {
                assert.equal(result.value.exitCode, 7);
            }

            assert.equal((await snapshot({ root })).executions.length, 0);
        } finally {
            connection.close();
            rmSync(root, { recursive: true, force: true });
        }
    },
);
