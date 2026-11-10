// A real picker and isolated server: delayed mutations cannot overtake another selection or follow navigation.
import { type App, cleanUp, newSession, openApp, owner, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
const MENU = '[role="dialog"][aria-label="Model"]';
const DEFAULT = '[role="dialog"][aria-label="Default model"]';
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let first: ConversationId;
let second: ConversationId;
let handler: ReturnType<typeof createHandler>;
let hold: "configure" | "settings" | undefined;
let held: { request: IncomingMessage; response: ServerResponse } | undefined;
let reject = false;
const mutations: string[] = [];

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const selection = (id: string) => `.model-picker-select[title^="faux/${id} "]`;
const clickModel = (id: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selection(id))}).click()`);
const clickThinking = (value: string) =>
    page.evaluate(`
        const button = [...document.querySelectorAll('.model-levels button')].find((item) => item.textContent.trim() === ${JSON.stringify(value)});
        if (!button) throw new Error('Missing thinking choice');
        button.click();
    `);
const pickerOpen = (defaults = false) =>
    inPage<boolean>(
        `return JSON.stringify(Boolean(document.querySelector(${JSON.stringify(defaults ? DEFAULT : MENU)})))`,
    );

async function open(id = first, defaults = false) {
    await page.evaluate(`(await import('/store.js')).navigate(${Number(id)});`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify((await import('/store.js')).store.state.view.conversation?.id === ${Number(id)})`,
            ),
        "the intended session is in view",
    );
    await page.evaluate(
        `(await import('/store.js')).openSheet({ type: 'model', forDefault: ${defaults} });`,
    );
    await until(() => pickerOpen(defaults), "the model picker opens");
}

async function release() {
    const waiting = held;

    assert.ok(waiting, "a mutation is held");
    held = undefined;
    await handler(waiting.request, waiting.response);
}

async function reset(id = first) {
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    await page.evaluate(`(await import('/store.js')).closeSheet();`);
    mutations.length = 0;
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(
        fauxProvider({
            models: [
                { id: "faux-1", reasoning: true },
                { id: "faux-2", reasoning: true },
                { id: "faux-3", reasoning: true },
                { id: "claude-opus-5-5", reasoning: true },
            ],
        }),
    );
    first = await newSession(app);
    second = await newSession(app);
    handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });
    server = createServer((request, response) => {
        const path = request.url ?? "";
        const kind = /\/configure$/.test(path)
            ? "configure"
            : path === "/api/settings"
              ? "settings"
              : undefined;

        if (request.method === "POST" && kind !== undefined) {
            mutations.push(path);

            if (reject) {
                reject = false;
                request.resume();
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: "Fabricated model change rejected" }));

                return;
            }

            if (hold === kind) {
                hold = undefined;
                held = { request, response };

                return;
            }
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "model-picker-race-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${first}`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector('.model-chip')))`,
            ),
        "the owner session opens",
        20_000,
    );
});

after(async () => {
    held?.response.destroy();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("rapid model choices and a reopened picker share one outstanding mutation", real, async () => {
    await reset();
    await open();
    hold = "configure";
    await page.evaluate(`
        document.querySelector(${JSON.stringify(selection("faux-2"))}).click();
        document.querySelector(${JSON.stringify(selection("faux-3"))}).click();
    `);
    await until(() => held !== undefined, "the first model change waits");
    assert.equal(mutations.length, 1);
    assert.equal(
        await inPage<boolean>(
            `return JSON.stringify([...document.querySelectorAll('.model-picker-select, .model-levels button')].every((button) => button.disabled))`,
        ),
        true,
    );
    await page.evaluate(`
        const { closeSheet, openSheet } = await import('/store.js');
        closeSheet();
        openSheet({ type: 'model' });
    `);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selection("faux-3"))})?.disabled === true)`,
            ),
        "the reopened picker retains the pending guard",
    );
    await clickModel("faux-3");
    assert.equal(mutations.length, 1);
    await release();
    await until(
        async () => (await app.agentState(first))?.model?.modelId === "faux-2",
        "the selected model commits",
    );
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(selection("faux-3"))})?.disabled === false)`,
            ),
        "the reopened picker unlocks",
    );
    assert.equal(await pickerOpen(), true, "an older completion cannot close the reopened picker");
    await clickModel("faux-3");
    await until(
        async () => (await app.agentState(first))?.model?.modelId === "faux-3",
        "a later deliberate choice works",
    );
});

test(
    "a delayed request keeps its captured session and cannot close another session's picker",
    real,
    async () => {
        await reset();
        await reset(second);
        await open();
        hold = "configure";
        await clickModel("faux-2");
        await until(() => held !== undefined, "the old session's request waits");
        await open(second);
        await release();
        await until(
            async () => (await app.agentState(first))?.model?.modelId === "faux-2",
            "the original target changes",
        );
        assert.equal((await app.agentState(second))?.model?.modelId, "faux-1");
        assert.equal(await pickerOpen(), true);
        await clickModel("faux-3");
        await until(
            async () => (await app.agentState(second))?.model?.modelId === "faux-3",
            "the second picker has its own target",
        );
    },
);

test(
    "a model sheet explicitly preserved across navigation cannot retarget its controls",
    real,
    async () => {
        await reset();
        await reset(second);
        await open();
        await page.evaluate(`
        const { navigate, store } = await import('/store.js');
        navigate(${Number(second)}, { sheet: store.state.sheet });
    `);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify((await import('/store.js')).store.state.view.conversation?.id === ${Number(second)} && document.querySelector(${JSON.stringify(selection("faux-2"))})?.disabled === true)`,
                ),
            "the old picker is locked on a different route",
        );
        await clickModel("faux-2");
        assert.equal(mutations.length, 0);
        assert.equal((await app.agentState(first))?.model?.modelId, "faux-1");
        assert.equal((await app.agentState(second))?.model?.modelId, "faux-1");
        await open(second);
        await clickModel("faux-3");
        await until(
            async () => (await app.agentState(second))?.model?.modelId === "faux-3",
            "a new logical picker captures the new route",
        );
    },
);

test(
    "failed model changes keep the picker open and release its guard for retry",
    real,
    async () => {
        await reset();
        await open();
        reject = true;
        await clickModel("faux-2");
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify((await import('/store.js')).store.state.notices.some((notice) => notice.message.includes('Fabricated model change rejected')))`,
                ),
            "the failed change is reported",
        );
        assert.equal((await app.agentState(first))?.model?.modelId, "faux-1");
        assert.equal(await pickerOpen(), true);
        await clickModel("faux-3");
        await until(
            async () => (await app.agentState(first))?.model?.modelId === "faux-3",
            "retry changes the model",
        );
    },
);

test(
    "thinking and owner defaults serialize model mutations without changing their targets",
    real,
    async () => {
        await reset();
        await open();
        hold = "configure";
        await page.evaluate(`
        const buttons = [...document.querySelectorAll('.model-levels button')];
        buttons.find((button) => button.textContent.trim() === 'low').click();
        buttons.find((button) => button.textContent.trim() === 'high').click();
    `);
        await until(() => held !== undefined, "the thinking change waits");
        assert.equal(mutations.length, 1);
        await release();
        await until(
            async () => (await app.agentState(first))?.thinkingLevel === "low",
            "thinking changes once",
        );
        assert.equal((await app.agentState(first))?.model?.modelId, "faux-1");
        await open(first, true);
        mutations.length = 0;
        hold = "settings";
        await page.evaluate(`
        document.querySelector(${JSON.stringify(selection("faux-2"))}).click();
        document.querySelector(${JSON.stringify(selection("faux-3"))}).click();
    `);
        await until(() => held !== undefined, "the default selection waits");
        assert.equal(mutations.length, 1);
        await release();
        await until(
            () => app.config.defaultModel?.modelId === "faux-2",
            "the selected default commits",
        );
        assert.equal(await pickerOpen(true), true);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll('.model-levels button')].some((button) => button.textContent.trim() === 'high' && !button.disabled))`,
                ),
            "the default thinking controls become available",
        );
        await clickThinking("high");
        await until(
            () => app.config.defaultModel?.thinkingLevel === "high",
            "default thinking changes",
        );
        assert.equal(
            (await app.agentState(first))?.thinkingLevel,
            "low",
            "the default does not reconfigure the open agent",
        );
    },
);

test("idle PiP picks stay on PiP and explicit Opus picks retain medium", real, async () => {
    await open(first);
    await clickModel("claude-opus-5-5");
    await until(
        async () => (await app.agentState(first))?.model?.modelId === "claude-opus-5-5",
        "Opus selected",
    );
    assert.equal((await app.agentState(first))?.thinkingLevel, "medium");
    await page.evaluate(`
        (await import('/theme.js')).setPrefs({ pip: 'floating' });
        await (await import('/pip.js')).openPip();
    `);
    await until(
        () =>
            inPage<boolean>(
                `const { store } = await import('/store.js'); return JSON.stringify(store.state.pip?.id !== undefined && store.state.pipView.conversation?.id === store.state.pip.id)`,
            ),
        "idle PiP has a model view",
    );
    const pip = await inPage<number>(
        `return JSON.stringify((await import('/store.js')).store.state.pip.id)`,
    );
    const other =
        (await app.agentState(pip as ConversationId))?.model?.modelId === "faux-3"
            ? "faux-2"
            : "faux-3";

    await page.evaluate(`
        const { store, openSheet } = await import('/store.js');
        openSheet({ type: 'model', pipId: store.state.pip.id });
    `);
    await until(() => pickerOpen(), "PiP's model picker opens");
    await clickModel(other);
    await until(
        async () => (await app.agentState(pip as ConversationId))?.model?.modelId === other,
        "PiP's own model changes",
    );
    assert.equal((await app.agentState(first))?.model?.modelId, "claude-opus-5-5");
});
