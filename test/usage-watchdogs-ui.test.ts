// Real owner UI against an isolated Pocket server; only the host watchdog bridge is replaced with fabricated data.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import type { UsageWatchdog, WatchdogStatus } from "../src/server/usage-watchdogs.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const PHONE = { width: 390, height: 844, scale: 1, mobile: true };
const SHEET = '[role="dialog"][aria-label="Usage watchdogs"]';
const CHECKED = "2026-11-09T10:20:42.000Z";
const NEXT = "2026-11-09T10:40:10.000Z";
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session = 0;
let failRead = false;
let failStop = false;
let holdRead = false;
let status: WatchdogStatus;
const stops: number[] = [];
const held: { response: ServerResponse; payload: WatchdogStatus }[] = [];

const row = (id: number, stopped = false): UsageWatchdog => ({
    session: id,
    active: !stopped,
    enabled: !stopped,
    stopped,
    switchingEnabled: !stopped,
    nextCheckAt: stopped ? null : NEXT,
    lastCheckedAt: CHECKED,
    currentProvider: "zack-claude-ryvolt",
    modelId: "claude-opus-5-5",
    lastAction: stopped ? "stopped" : "ok",
    switched: false,
    stoppedAt: stopped ? CHECKED : null,
});
const fixture = () => ({ available: true, watchdogs: [row(session), row(93063, true)] });

const reply = (response: ServerResponse, payload: unknown, code = 200) => {
    if (!response.headersSent) {
        response.writeHead(code, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        });
    }

    response.end(JSON.stringify(payload));
};

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const content = () =>
    inPage<string>(`return JSON.stringify(document.querySelector('${SHEET}')?.textContent ?? "")`);
const ready = () =>
    until(
        async () => (await content()).includes("active usage watchdogs"),
        "watchdog status rendered",
    );
const click = (text: string) =>
    page.evaluate(`
    const button = [...document.querySelectorAll('${SHEET} button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('Missing watchdog control');
    button.click();
`);

async function openFromMenu() {
    await page.evaluate(`document.querySelector('.topbar [aria-label="Menu"]').click()`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll('.nav-menu button')].some((button) => button.textContent.includes('Usage watchdogs')))`,
            ),
        "owner menu exposes Usage watchdogs",
    );
    await page.evaluate(`
        [...document.querySelectorAll('.nav-menu button')].find((button) => button.textContent.includes('Usage watchdogs')).click();
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('${SHEET}') !== null)`,
            ),
        "watchdog sheet opens from menu",
    );
}

async function close() {
    await page.evaluate(`document.querySelector('${SHEET} [aria-label="Close"]').click()`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('${SHEET}') === null)`,
            ),
        "watchdog sheet closes",
    );
}

async function screenshot(name: string) {
    const directory = process.env.PI_POCKET_UI_ARTIFACTS;

    if (directory) {
        // Capture the settled sheet, after its responsive entrance animation.
        await page.evaluate(`await new Promise((resolve) => setTimeout(resolve, 450))`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, name + ".jpg"),
            Buffer.from((await page.screenshot()).data, "base64"),
        );
    }
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    session = Number(await newSession(app));
    status = fixture();
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer(async (request, response) => {
        if (request.url === "/api/usage-watchdogs" && request.method === "GET") {
            if (failRead) {
                reply(response, { error: "Fabricated host status failure" }, 503);
            } else if (holdRead) {
                holdRead = false;
                // Match the real API's no-store headers so Chrome does not serialize a second GET behind this one.
                response.writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                });
                response.flushHeaders();
                held.push({ response, payload: structuredClone(status) });
            } else {
                reply(response, status);
            }

            return;
        }

        if (request.url === "/api/usage-watchdogs/stop" && request.method === "POST") {
            let raw = "";

            for await (const chunk of request) {
                raw += chunk;
            }

            const body = JSON.parse(raw);

            stops.push(body.session);

            if (failStop) {
                reply(response, { error: "Fabricated stop failure" }, 503);
            } else {
                status = {
                    ...status,
                    watchdogs: status.watchdogs.map((watchdog) =>
                        watchdog.session === body.session ? row(watchdog.session, true) : watchdog,
                    ),
                };
                reply(response, status);
            }

            return;
        }

        await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "watchdogs-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(DESKTOP);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('.topbar [aria-label="Menu"]') !== null)`,
            ),
        "the owner session opens",
        20_000,
    );
});

after(async () => {
    for (const pending of held.splice(0)) {
        reply(pending.response, pending.payload);
    }

    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "owner opens watchdogs from the real menu and sees session, provider and check times",
    real,
    async () => {
        await openFromMenu();
        await ready();
        const text = await content();
        const times = await inPage<string[]>(
            `return JSON.stringify([new Date(${JSON.stringify(CHECKED)}).toLocaleString(), new Date(${JSON.stringify(NEXT)}).toLocaleString()])`,
        );

        assert.match(text, /1 active usage watchdogs/);
        assert.ok(text.includes(`Session ${session}`));
        assert.ok(text.includes("zack-claude-ryvolt"));
        assert.ok(text.includes(`Last check: ${times[0]}`));
        assert.ok(text.includes(`Next check: ${times[1]}`));
        assert.ok(text.includes("Kept current provider"));
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('[data-watchdog="${session}"] strong').textContent)`,
            ),
            "On",
        );
        await screenshot("watchdogs-desktop");
    },
);

test(
    "Stop targets one session and an older in-flight status response cannot revive its UI",
    real,
    async () => {
        holdRead = true;
        await click("Refresh watchdogs");
        await until(() => held.length === 1, "an older status read waits");
        await click("Stop watchdog");
        await until(
            async () => (await content()).includes("0 active usage watchdogs"),
            "stopped status refreshes",
        );
        assert.deepEqual(stops, [session]);
        const old = held.shift()!;

        reply(old.response, old.payload);
        await page.evaluate(`await new Promise((resolve) => setTimeout(resolve, 100))`);
        assert.ok(
            (await content()).includes("0 active usage watchdogs"),
            "late old status does not replace stopped data",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll('${SHEET} button')].some((button) => button.textContent.trim() === 'Stop watchdog'))`,
            ),
            false,
        );
        await page.evaluate(`document.querySelector('${SHEET} details summary').click()`);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('${SHEET} details').open)`,
            ),
            true,
        );
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('[data-watchdog="${session}"] strong').textContent)`,
            ),
            "Stopped",
        );
        assert.ok((await content()).includes("Stopped:"));
    },
);

test(
    "failed status refresh retains last-known rows and reports unknown instead of claiming off",
    real,
    async () => {
        status = fixture();
        await click("Refresh watchdogs");
        await until(
            async () => (await content()).includes("1 active usage watchdogs"),
            "active fixture restored",
        );
        failRead = true;
        await click("Refresh watchdogs");
        await until(
            async () => (await content()).includes("Their current status is unknown."),
            "status read failure is shown",
        );
        const text = await content();

        assert.match(text, /Last known status shown below/);
        assert.doesNotMatch(text, /0 active usage watchdogs/);
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('[data-watchdog="${session}"] strong').textContent)`,
            ),
            "On",
        );
        await close();
        await openFromMenu();
        await until(
            async () => (await content()).includes("Their current status is unknown."),
            "first-load failure is shown",
        );
        assert.doesNotMatch(await content(), /active usage watchdogs/);
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll('${SHEET} [data-watchdog]').length)`,
            ),
            0,
        );
        failRead = false;
        await click("Refresh watchdogs");
        await ready();
    },
);

test("failed Stop keeps its active row and the watchdog view fits a phone", real, async () => {
    failStop = true;
    await click("Stop watchdog");
    await until(
        async () => (await content()).includes("Could not stop this watchdog."),
        "stop failure is shown",
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify(document.querySelector('[data-watchdog="${session}"] strong').textContent)`,
        ),
        "On",
    );
    assert.ok((await content()).includes("Last known status shown below"));
    await page.setViewport(PHONE);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector('${SHEET}').getBoundingClientRect().right <= innerWidth)`,
            ),
        "phone sheet fits",
    );
    assert.equal(
        await inPage<boolean>(
            `const body = document.querySelector('${SHEET} .sheet-body'); return JSON.stringify(body.scrollWidth <= body.clientWidth && document.documentElement.scrollWidth <= innerWidth)`,
        ),
        true,
        "watchdog controls have no horizontal overflow",
    );
    await screenshot("watchdogs-mobile");
});
