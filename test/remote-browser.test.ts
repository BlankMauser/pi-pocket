import {
    cleanUp,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";
import { machineFolder } from "../src/server/workers.ts";

const handlerPath = "../../pocket-workers/handlers.mjs";
const browserHandlerPath = "../../pocket-workers/browser-handler.mjs";
const { handleRpc } = (await import(handlerPath)) as {
    handleRpc(op: string, args: Record<string, unknown>): Promise<unknown>;
};

after(() => cleanUp());

test(
    "the native browser tool and phone panel share the worker's local page, frames and input",
    { skip: findBrowser() === undefined ? "no Chromium installed" : false },
    async () => {
        const data = join(root, "browser-app");

        mkdirSync(join(data, "gateway"), { recursive: true });
        writeFileSync(join(data, "gateway", "control-token"), "test-only-token");
        process.env.PI_POCKET_WORKER_STATE = join(root, "worker-state");
        const site = createServer((_request, response) => {
            response.end(
                "<html><head><title>Worker local page</title></head><body><h1>Worker page</h1><button onclick=\"this.textContent='Clicked on worker'\">Tap me</button></body></html>",
            );
        });

        await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
        const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
        const calls: string[] = [];
        const gateway = createServer(async (request, response) => {
            response.setHeader("content-type", "application/json");

            try {
                assert.equal(request.headers.authorization, "Bearer test-only-token");
                const chunks: Buffer[] = [];

                for await (const chunk of request) {
                    chunks.push(Buffer.from(chunk));
                }

                const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                    machineId: string;
                    op: string;
                    args: Record<string, unknown>;
                };

                assert.equal(body.machineId, "desktop");
                assert.equal(body.args.cwd, work);
                calls.push(body.op);
                response.end(JSON.stringify(await handleRpc(body.op, body.args)));
            } catch (error) {
                response.statusCode = (error as { status?: number }).status ?? 500;
                response.end(JSON.stringify({ error: (error as Error).message }));
            }
        });

        await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
        process.env.PI_POCKET_WORKER_GATEWAY = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
        const results: string[] = [];
        const app = await openApp(
            scriptedModel((request) => {
                const last = lastText(request as never);

                if (last.role === "toolResult") {
                    results.push(last.text);

                    return fauxAssistantMessage([fauxText("done")]);
                }

                return fauxAssistantMessage(
                    [fauxToolCall("browser", { action: "navigate", url: siteUrl, snapshot: true })],
                    { stopReason: "toolUse" },
                );
            }),
            data,
        );
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
        const request = (token: string, path: string, body?: unknown) =>
            fetch(`${api}/${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });

        try {
            const id = await newSession(app, machineFolder("desktop", work));

            await loadTools(app, id, "browser");

            await say(app, id, "open the worker local page");
            assert.ok(calls.includes("browser.tool"));
            assert.match(results.join("\n"), /Worker page/);
            assert.match(results.join("\n"), /Worker local page/);
            const state = await request(app.config.ownerToken, `c/${id}/browser`);

            assert.equal(state.status, 200);
            assert.equal(((await state.json()) as { title: string }).title, "Worker local page");
            const frame = await request(app.config.ownerToken, `c/${id}/browser/frame`);

            assert.equal(frame.status, 200);
            assert.equal(frame.headers.get("content-type"), "image/jpeg");
            assert.deepEqual(
                [...new Uint8Array(await frame.arrayBuffer()).slice(0, 3)],
                [255, 216, 255],
            );
            const changed = await app.browsers.remote<{ output: { text?: string }[] }>(
                Number(id),
                "tool",
                { args: { action: "click", label: "Tap me", snapshot: true } },
            );

            assert.match(
                changed.output.map((item) => item.text ?? "").join("\n"),
                /Clicked on worker/,
            );
            const viewer = app.config.addUser("Viewer", "viewer");

            assert.equal(
                (await request(viewer.token, `c/${id}/browser/input`, { events: [] })).status,
                403,
            );
            const guest = app.config.addUser("Guest", "guest");

            assert.equal(
                (await request(guest.token, `c/${id}/browser/navigate`, { url: "/etc/passwd" }))
                    .status,
                400,
            );
            const servers = await request(guest.token, `c/${id}/browser/servers`);

            assert.deepEqual(await servers.json(), { servers: [] });
            assert.equal(
                (
                    await request(app.config.ownerToken, `c/${id}/browser/navigate`, {
                        url: "javascript:alert(1)",
                    })
                ).status,
                400,
            );
            await app.setExtensionEnabled(owner(app), "browser.ts", false);
            assert.equal((await request(app.config.ownerToken, `c/${id}/browser`)).status, 404);
        } finally {
            await app.close();
            const handlers = (await import(browserHandlerPath)) as {
                closeWorkerBrowsers(): Promise<void>;
            };

            await handlers.closeWorkerBrowsers();

            for (const item of [server, gateway, site]) {
                item.closeAllConnections();
                await new Promise<void>((resolve) => item.close(() => resolve()));
            }

            delete process.env.PI_POCKET_WORKER_GATEWAY;
            delete process.env.PI_POCKET_WORKER_STATE;
        }
    },
);
