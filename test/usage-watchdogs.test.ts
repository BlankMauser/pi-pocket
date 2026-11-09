import { cleanUp, openApp, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { UsageWatchdogs } from "../src/server/usage-watchdogs.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test("watchdog bridge shares status reads and only stops validated numeric IDs", async () => {
    const calls: string[][] = [];
    const monitor = new UsageWatchdogs(
        async (args) => {
            calls.push(args);
            await new Promise((resolve) => setTimeout(resolve, 5));

            return args[0] === "status"
                ? { available: true, watchdogs: [] }
                : { session: Number(args[1]), stopped: true };
        },
        () => true,
    );

    await Promise.all([monitor.status(), monitor.status()]);
    assert.deepEqual(calls, [["status"]]);
    assert.deepEqual(await monitor.stop(93063), { session: 93063, stopped: true });

    for (const id of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(monitor.stop(id), { status: 400 });
    }

    assert.deepEqual(calls, [["status"], ["stop", "93063"]]);
});

test("missing bridge and failed operations never report a verified stop or no active watchdogs", async () => {
    const absent = new UsageWatchdogs(
        async () => {
            throw new Error("must not run");
        },
        () => false,
    );

    assert.equal((await absent.status()).available, false);
    await assert.rejects(absent.stop(93063), { status: 503 });

    for (const reply of [null, {}, { stopped: false }, { session: 2, stopped: true }]) {
        const bad = new UsageWatchdogs(
            async () => reply,
            () => true,
        );

        await assert.rejects(bad.status(), { status: 503 });
        await assert.rejects(bad.stop(93063), { status: 503 });
    }

    const failing = new UsageWatchdogs(
        async () => {
            throw new Error("private subprocess output");
        },
        () => true,
    );

    await assert.rejects(failing.status(), (error: Error) => !error.message.includes("private"));
    await assert.rejects(failing.stop(93063), (error: Error) => !error.message.includes("private"));
});

test("watchdog API requires owner auth and same-origin mutation protection", async () => {
    const app = await openApp(scriptedModel());
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/usage-watchdogs`;
    const guest = app.config.addUser("Guest", "guest").token;
    const headers = (token: string) => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pocket": "1",
    });

    try {
        assert.equal((await fetch(base)).status, 401);
        assert.equal((await fetch(base, { headers: headers(guest) })).status, 403);
        assert.equal(
            (
                await fetch(`${base}/stop`, {
                    method: "POST",
                    headers: headers(guest),
                    body: JSON.stringify({ session: 93063 }),
                })
            ).status,
            403,
        );
        assert.equal(
            (
                await fetch(`${base}/stop`, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${app.config.ownerToken}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ session: 93063 }),
                })
            ).status,
            403,
        );
        assert.equal(
            (
                await fetch(`${base}/stop`, {
                    method: "POST",
                    headers: headers(app.config.ownerToken),
                    body: JSON.stringify({ session: "93063; invalid" }),
                })
            ).status,
            400,
        );
        const response = await fetch(base, { headers: headers(app.config.ownerToken) });

        assert.equal(response.status, 200);
        assert.equal(typeof (await response.json()).available, "boolean");
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});

test("a status read started before Stop cannot satisfy the post-stop refresh", async () => {
    let finishOld: (value: unknown) => void = () => {};

    let reads = 0;
    const monitor = new UsageWatchdogs(
        async (args) => {
            if (args[0] === "stop") {
                return { session: 93063, stopped: true };
            }

            if (++reads === 1) {
                return new Promise((resolve) => {
                    finishOld = resolve;
                });
            }

            return {
                available: true,
                watchdogs: [{ session: 93063, active: false, stopped: true }],
            };
        },
        () => true,
    );
    const oldRead = monitor.status();

    await monitor.stop(93063);
    const afterStop = await monitor.status();

    assert.equal(reads, 2);
    assert.equal(afterStop.watchdogs[0]!.active, false);
    finishOld({ available: true, watchdogs: [{ session: 93063, active: true, stopped: false }] });
    await oldRead;
    assert.equal((await monitor.status()).watchdogs[0]!.active, false);
});
