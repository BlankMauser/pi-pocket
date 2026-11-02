import {
    context,
    lastText,
    modelTexts,
    say,
    until,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SubagentsDoc } from "../src/server/docs.ts";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { machineFolder, machinePath } from "../src/server/workers.ts";

const handlersPath = "../../pocket-workers/handlers.mjs";
const { handleRpc } = (await import(handlersPath)) as {
    handleRpc: (op: string, args: Record<string, unknown>) => Promise<unknown>;
};

after(() => cleanUp());

test("machine folders round-trip native Linux and Windows paths", () => {
    assert.deepEqual(machinePath("mm://desktop/home/person/../person/project"), {
        machineId: "desktop",
        path: "/home/person/project",
    });
    assert.deepEqual(machinePath("mm://cydonia-gpu/C:/Users/ciaru"), {
        machineId: "cydonia-gpu",
        path: "C:\\Users\\ciaru",
    });
    assert.equal(
        machineFolder("cydonia-gpu", "C:\\Users\\ciaru\\project"),
        "mm://cydonia-gpu/C:/Users/ciaru/project",
    );
    assert.equal(
        machineFolder("desktop", "/home/person/project"),
        "mm://desktop/home/person/project",
    );
    assert.equal(machinePath(work), undefined);
    assert.throws(() => machinePath("mm://../../secret"), { status: 400 });
    assert.throws(() => machinePath("mm://desktop/home/\0secret"), { status: 400 });
});

test("worker file reads enforce symlink confinement and hide credentials from guests", async () => {
    const project = join(root, "worker-project");
    const outside = join(root, "outside.txt");

    mkdirSync(project);
    writeFileSync(join(project, "inside.txt"), "project file");
    writeFileSync(outside, "outside file");
    symlinkSync(outside, join(project, "escape.txt"));
    writeFileSync(
        join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
        '{"private-provider":{"type":"api_key","key":"test-only-secret"}}',
    );
    const args = { cwd: project, restricted: true, owner: false, lineage: [] };
    const read = (await handleRpc("fs.readFile", { ...args, path: "inside.txt" })) as {
        data: string;
    };

    assert.equal(Buffer.from(read.data, "base64").toString(), "project file");
    await assert.rejects(handleRpc("fs.readFile", { ...args, path: "escape.txt" }), {
        status: 404,
    });
    await assert.rejects(
        handleRpc("fs.readFile", {
            ...args,
            restricted: false,
            path: join(process.env.PI_CODING_AGENT_DIR!, "auth.json"),
        }),
        { status: 404 },
    );
    await assert.rejects(
        handleRpc("fs.readFile", { ...args, cwd: "relative", path: "inside.txt" }),
        { status: 400 },
    );
});

test("remote folder browsing and sessions use worker RPC; offline and plain VM paths cannot fall back", async () => {
    const data = join(root, "remote-app");

    mkdirSync(join(data, "plannotator"), { recursive: true });
    writeFileSync(join(data, "plannotator", "control-token"), "test-only-control-token");
    const calls: string[] = [];
    let online = true;
    const gateway = createServer(async (request, response) => {
        assert.equal(request.headers.authorization, "Bearer test-only-control-token");
        response.setHeader("content-type", "application/json");

        try {
            if (request.url?.endsWith("/list")) {
                response.end(
                    JSON.stringify([
                        { id: "desktop", name: "Desktop", online, home: root, cwd: work },
                    ]),
                );

                return;
            }

            const chunks: Buffer[] = [];

            for await (const chunk of request) {
                chunks.push(Buffer.from(chunk));
            }

            const input = JSON.parse(Buffer.concat(chunks).toString()) as {
                machineId: string;
                op: string;
                args: Record<string, unknown>;
            };

            assert.equal(input.machineId, "desktop");
            calls.push(input.op);

            if (!online) {
                throw Object.assign(new Error("Desktop is offline"), { status: 503 });
            }

            response.end(JSON.stringify(await handleRpc(input.op, input.args)));
        } catch (error) {
            response.statusCode = (error as { status?: number }).status ?? 500;
            response.end(JSON.stringify({ error: (error as Error).message }));
        }
    });

    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayAddress = gateway.address() as { port: number };

    process.env.PI_POCKET_WORKER_GATEWAY = `http://127.0.0.1:${gatewayAddress.port}`;
    const app = await openApp(
        scriptedModel((request) => {
            const last = lastText(request as never);

            return last.role !== "toolResult" && last.text.endsWith("start a helper")
                ? fauxAssistantMessage(
                      [
                          fauxToolCall("subagent", {
                              action: "spawn",
                              name: "helper",
                              message: "reply hello",
                          }),
                      ],
                      { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage([fauxText(`echo: ${last.text}`)]);
        }),
        data,
    );
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const api = (path: string) =>
        fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
            headers: { authorization: `Bearer ${app.config.ownerToken}` },
        });

    try {
        const cwd = machineFolder("desktop", work);
        const folders = await api(`fs?path=${encodeURIComponent(cwd)}`);

        assert.equal(folders.status, 200);
        assert.equal(((await folders.json()) as { path: string }).path, cwd);
        assert.ok(calls.includes("fs.list"));
        const id = await newSession(app, cwd);

        assert.equal(app.cwdOf(id), cwd);
        assert.equal(app.envFor(id).id, "matchamill:desktop");
        await say(app, id, "start a helper");
        await until(
            async () =>
                (await modelTexts(app, id)).some((text) =>
                    text.includes("[subagent helper answered"),
                ),
            "remote helper reply",
        );
        const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
            .conversationId;

        assert.equal(app.cwdOf(helper), cwd);
        await until(() => !app.isBusy(id) && !app.isBusy(helper), "remote agents settled");
        const page = await (await app.harness.conversation(id, context))!.entries(
            {},
            50,
            undefined,
            context,
        );
        const answer = page.items.find((entry) => entry.kind === "pi.assistant")!;
        const fork = await app.commands.fork(id, owner(app), { entryId: Number(answer.id) });

        assert.equal(app.cwdOf(fork.id), cwd);
        const viewer = app.config.addUser("Viewer", "viewer").user;

        await assert.rejects(
            app.workspace.makeWorkingFolder(
                viewer,
                machineFolder("desktop", join(work, "forbidden")),
            ),
            { status: 403 },
        );
        online = false;
        await assert.rejects(newSession(app, cwd), { status: 503 });
        assert.equal((await api(`fs?path=${encodeURIComponent(cwd)}`)).status, 503);
        process.env.PI_POCKET_WORKERS_ONLY = "1";
        await assert.rejects(newSession(app, work), { status: 400 });
        await assert.rejects(app.workspace.makeWorkingFolder(owner(app), join(root, "vm-folder")), {
            status: 400,
        });
    } finally {
        delete process.env.PI_POCKET_WORKERS_ONLY;
        await app.close();
        server.closeAllConnections();
        gateway.closeAllConnections();
        await Promise.all([
            new Promise<void>((resolve) => server.close(() => resolve())),
            new Promise<void>((resolve) => gateway.close(() => resolve())),
        ]);
        delete process.env.PI_POCKET_WORKER_GATEWAY;
    }
});
