// Real, headless Chromium checks the atomic queue controls against the served application UI.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
const BULK = ".queue-bulk-actions";
const BOX = ".composer textarea";
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
let session: ConversationId;
let viewerToken: string;

const run = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const sees = (expression: string, label: string) =>
    until(() => run<boolean>(`return JSON.stringify(${expression})`), label);
const clicks = (selector: string, count = 1) =>
    run(`
        for (let i = 0; i < ${count}; i++) document.querySelector(${JSON.stringify(selector)}).click();
        return "null";
    `);

type QueueRequest = { url: string; body: { action: string; ids: number[] } };
const requests = () => run<QueueRequest[]>(`return JSON.stringify(globalThis.queueRequests)`);
const draft = () =>
    run<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}).value)`);
const typeDraft = (text: string) =>
    run(`
        const box = document.querySelector(${JSON.stringify(BOX)});
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);

async function login(token: string): Promise<void> {
    await page.navigate(`${base}/login?token=${encodeURIComponent(token)}&next=/s/${session}`);

    if (await run<boolean>(`return JSON.stringify(location.pathname === "/login")`)) {
        await page.click({ selector: 'form button[type="submit"]' });
    }
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);
    viewerToken = app.config.addUser("Queue viewer", "viewer", [String(session)]).token;
    server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "queue-controls-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await login(app.config.ownerToken);
});

beforeEach(async () => {
    if (real.skip) {
        return;
    }

    await page.setViewport(VIEWPORTS.desktop);
    await login(app.config.ownerToken);
    await page.navigate(`${base}/s/${session}`);
    await sees(
        `document.querySelector(${JSON.stringify(BOX)}) !== null &&
        (await import("/store.js")).store.state.view.conversation?.id === ${session}`,
        "the composer",
    );
    await run(`
        const { store, drafts } = await import("/store.js");
        const id = store.state.me.id;
        globalThis.queueRequests = [];
        globalThis.submitRequests = [];
        globalThis.originalFetch = fetch;
        globalThis.holdQueue = false;
        globalThis.holdSubmit = false;
        globalThis.queueStatus = 200;
        globalThis.fetch = async (url, options) => {
            if (String(url).endsWith("/queue")) {
                globalThis.queueRequests.push({url: String(url), body: JSON.parse(options.body)});
                if (globalThis.holdQueue) await new Promise(resolve => globalThis.releaseQueue = resolve);
                return new Response(JSON.stringify(globalThis.queueStatus === 200 ? {ok:true} : {error:"Queue changed; try again"}),
                    {status:globalThis.queueStatus, headers:{"content-type":"application/json"}});
            }
            if (String(url).endsWith("/submit")) {
                globalThis.submitRequests.push(JSON.parse(options.body));
                if (globalThis.holdSubmit) await new Promise(resolve => globalThis.releaseSubmit = resolve);
                return new Response('{"submissionId":700}', {headers:{"content-type":"application/json"}});
            }
            return globalThis.originalFetch(url, options);
        };
        store.set(state => ({view:{...state.view, live:{...state.view.live,busy:true}, inbox:[
            {id:101,by:id,mode:"followUp",text:"own first"},
            {id:103,by:"other-person",mode:"followUp",text:"other person's message"},
            {id:102,by:id,mode:"steer",text:"own second"},
            {id:104,mode:"steer",reports:["worker"],text:"worker report"},
            {id:105,by:id,mode:"note",text:"extension note"},
            {id:106,by:id,mode:"steer",reports:["other worker"],text:"attributed report"},
        ]}}));
        drafts.set(${session}, "");
        return "null";
    `);
    await typeDraft("");
    await sees(
        `document.querySelector(${JSON.stringify(BULK)})?.textContent.includes("Steer all (2)")`,
        "bulk controls",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "Steer all sends one ordered own-message selection, locks duplicate taps, and preserves the draft and attachment",
    real,
    async () => {
        await typeDraft("Keep this unsent draft");
        await run(`
        const files = new DataTransfer();
        files.items.add(new File(["private test fixture"], "keep.txt", {type:"text/plain"}));
        const input = document.querySelector('.composer input[type="file"]');
        input.files = files.files;
        input.dispatchEvent(new Event("change", {bubbles:true}));
        globalThis.holdQueue = true;
        return "null";
    `);
        await sees(
            `document.querySelector('.composer .files')?.textContent.includes("keep.txt") &&
        !document.querySelector('.composer .files .spinner')`,
            "the attached fixture",
        );
        await clicks(`${BULK} button:first-child`, 3);
        await sees(`globalThis.queueRequests.length === 1`, "one atomic request");
        assert.deepEqual(await requests(), [
            {
                url: `/api/c/${session}/queue`,
                body: { action: "steer", ids: [101, 102] },
            },
        ]);
        await sees(
            `[...document.querySelectorAll('${BULK} button')].every(button => button.disabled)
        && document.querySelector('.composer .send-button').disabled`,
            "the action lock",
        );
        assert.equal(await draft(), "Keep this unsent draft");
        assert.equal(
            await run(
                `return JSON.stringify(document.querySelector('.composer .files').textContent.includes("keep.txt"))`,
            ),
            true,
        );
        await run(`globalThis.releaseQueue(); return "null"`);
        await sees(
            `!document.querySelector('${BULK} button').disabled`,
            "the queue action completed",
        );
        assert.equal(await draft(), "Keep this unsent draft");
        assert.equal(
            await run(
                `return JSON.stringify((await import("/store.js")).store.state.view.inbox.length)`,
            ),
            6,
        );
    },
);

test(
    "Interrupt all confirms the current selection and sends one atomic request without altering other queue rows",
    real,
    async () => {
        await clicks(`${BULK} button:last-child`);
        await sees(
            `document.querySelector('${BULK} button:last-child').textContent.includes("all?")`,
            "interrupt confirmation",
        );
        assert.deepEqual(await requests(), []);
        await run(`
        const {store}=await import("/store.js");
        store.set(state=>({view:{...state.view,inbox:[...state.view.inbox,{id:107,by:state.me.id,mode:"followUp",text:"own third"}]}}));
        return "null";
    `);
        await sees(
            `document.querySelector('${BULK} button:last-child').textContent.includes("all (3)")`,
            "selection changed",
        );
        await clicks(`${BULK} button:last-child`);
        await sees(
            `document.querySelector('${BULK} button:last-child').textContent.includes("all?")`,
            "fresh confirmation",
        );
        assert.deepEqual(await requests(), []);
        await clicks(`${BULK} button:last-child`);
        await sees(`globalThis.queueRequests.length === 1`, "confirmed interrupt");
        assert.deepEqual((await requests())[0]!.body, {
            action: "interrupt",
            ids: [101, 102, 107],
        });
        assert.equal(
            await run(
                `return JSON.stringify((await import("/store.js")).store.state.view.inbox.length)`,
            ),
            7,
        );
        assert.match(
            await run<string>(
                `return JSON.stringify(document.querySelector('.mode-switch .interrupt').title)`,
            ),
            /stay queued/,
        );
        assert.doesNotMatch(
            await run<string>(
                `return JSON.stringify(document.querySelector('.mode-switch .interrupt').title)`,
            ),
            /clear/i,
        );
    },
);

test(
    "bulk actions respect driver/viewer permissions and per-message actions stay available",
    real,
    async () => {
        await clicks(".inbox .queued:first-child .queued-text");
        await sees(
            `document.querySelector('.inbox .queued:first-child .queued-actions')?.textContent.includes("Interrupt now")`,
            "per-message controls",
        );
        await run(`
        const {store}=await import("/store.js");
        store.set(state=>({view:{...state.view,turns:{on:true,driver:"other-person"}}}));
        return "null";
    `);
        await sees(`document.querySelector('${BULK}') === null`, "only the driver may act");
        assert.deepEqual(await requests(), []);
        await login(viewerToken);
        await sees(
            `document.querySelector('.view-only') !== null && document.querySelector('${BULK}') === null`,
            "viewer cannot steer",
        );
    },
);

test(
    "a draft send locks bulk actions and keeps the retained request id until its response",
    real,
    async () => {
        await typeDraft("An ordinary pending send");
        await run(`globalThis.holdSubmit=true; return "null"`);
        await clicks(".composer .send-button");
        await sees(
            `globalThis.submitRequests.length === 1 && [...document.querySelectorAll('${BULK} button')].every(button=>button.disabled)`,
            "draft send lock",
        );
        await clicks(`${BULK} button:first-child`, 2);
        assert.deepEqual(await requests(), []);
        assert.equal(await draft(), "An ordinary pending send");
        assert.equal(
            await run(`return JSON.stringify(typeof globalThis.submitRequests[0].requestId)`),
            "string",
        );
        await run(`globalThis.releaseSubmit(); return "null"`);
        await sees(
            `document.querySelector(${JSON.stringify(BOX)}).value === ""`,
            "acknowledged draft send",
        );
    },
);

test(
    "failed queue actions can be retried without losing the draft, and controls fit a phone",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await typeDraft("Keep after failure");
        await run(`globalThis.queueStatus=409; return "null"`);
        await clicks(`${BULK} button:first-child`);
        await sees(
            `globalThis.queueRequests.length === 1 && !document.querySelector('${BULK} button').disabled`,
            "failed action unlocked",
        );
        assert.equal(await draft(), "Keep after failure");
        await run(`globalThis.queueStatus=200; return "null"`);
        await clicks(`${BULK} button:first-child`);
        await sees(`globalThis.queueRequests.length === 2`, "retry");
        assert.deepEqual(
            (await requests()).map((each) => each.body),
            [
                { action: "steer", ids: [101, 102] },
                { action: "steer", ids: [101, 102] },
            ],
        );
        assert.equal(
            await run(`
        const controls=[...document.querySelectorAll('${BULK} button')];
        return JSON.stringify(controls.every(button=>{
            const rect=button.getBoundingClientRect();
            return rect.width>0 && rect.left>=0 && rect.right<=innerWidth;
        }));
    `),
            true,
        );
    },
);
