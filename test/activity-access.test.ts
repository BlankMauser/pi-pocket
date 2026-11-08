import { cleanUp, newSession, openApp, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";

after(() => cleanUp());

test("activity includes unrelated chats but never leaks private chats into a shared transcript", async () => {
    const app = await openApp(scriptedModel());

    try {
        const source = await newSession(app);
        const other = await newSession(app);
        const unknown = await newSession(app);

        await say(app, source, "hello");
        app.workers.list = async () => [
            { id: "fixture", name: "Fixture", online: true, home: "/tmp" },
        ];
        let scope: Record<string, unknown> = {};

        app.workers.rpc = async <T>(
            _cwd: string,
            op: string,
            args: Record<string, unknown> = {},
        ) => {
            assert.equal(op, "activity.snapshot");
            scope = args;

            return { executions: [], locks: [] } as T;
        };

        await app.machineActivity(source, "fixture");
        assert.ok((scope.conversationIds as string[]).includes(String(other)));
        const guest = app.config.addUser("Shared viewer", "viewer", [String(source)]).user;

        await app.machineActivity(source, "fixture");
        assert.deepEqual(scope.conversationIds, [String(source)]);
        assert.equal(typeof scope.instanceId, "string");
        await assert.rejects(app.machineActivity(unknown, "fixture"), /Session access required/);
        app.config.removeUser(guest.id);
        await assert.rejects(app.machineActivity(source, "missing"), /Machine is unavailable/);
    } finally {
        await app.close();
    }
});
