// Subscription UI with fabricated quota responses; no account credentials or provider requests are used.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };
const PHONE = { width: 390, height: 844, scale: 1, mobile: true };
const SHEET = '[role="dialog"][aria-label="Subscription usage"]';
const resetAt = new Date(Date.now() + 5 * 86400_000 + 7200_000).toISOString();
const baseWindows = [
    {
        id: "five_hour",
        label: "Five hours",
        usedPercent: 25,
        resetAt: new Date(Date.now() + 7200_000).toISOString(),
    },
    { id: "seven_day", label: "Weekly", usedPercent: 61, resetAt },
];
const fableWindow = (shares: Record<string, number> = {}) => ({
    id: "seven_day_fable",
    label: "Weekly · Fable",
    usedPercent: 2,
    resetAt,
    ...shares,
});
const fixture = (fable: Record<string, unknown> | null, fableMessage?: string) => ({
    accounts: [
        {
            id: "claude-ui-fixture",
            name: "Claude test subscription",
            state: "ready",
            stale: false,
            checkedAt: new Date().toISOString(),
            nextCheckAt: "2020-01-01T00:00:00Z",
            windows: [...baseWindows, ...(fable === null ? [] : [fable])],
            ...(fableMessage === undefined ? {} : { fableMessage }),
        },
    ],
});
let payload = fixture(fableWindow({ allowancePercentOfWeekly: 50, usedPercentOfWeekly: 1 }));
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let reads = 0;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const content = () =>
    inPage<string>(`return JSON.stringify(document.querySelector('${SHEET}')?.textContent ?? "")`);
const meter = (label: string) =>
    inPage<{ now: string; text: string; width: string } | null>(`
    const element = document.querySelector('${SHEET} [role="progressbar"][aria-label=${JSON.stringify(label)}]');
    return JSON.stringify(element ? { now: element.getAttribute('aria-valuenow'), text: element.getAttribute('aria-valuetext'), width: element.firstElementChild.style.width } : null);
`);

async function refresh() {
    const before = reads;

    await page.evaluate(
        `const button = [...document.querySelectorAll('${SHEET} button')].find(item => item.textContent.trim() === 'Refresh'); if (!button || button.disabled) throw new Error('Refresh unavailable'); button.click()`,
    );
    await until(() => reads > before, "fabricated usage refreshed");
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll('${SHEET} button')].some(item => item.textContent.trim() === 'Refresh' && !item.disabled))`,
            ),
        "refresh finished",
    );
}

async function screenshot(name: string) {
    const directory = process.env.PI_POCKET_UI_ARTIFACTS;

    if (directory) {
        await page.evaluate(
            `await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => setTimeout(resolve, 100))`,
        );
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
    const session = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        if (request.url === "/api/subscription-usage" && request.method === "GET") {
            reads++;
            response.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            });
            response.end(JSON.stringify(payload));

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "fable-usage-ui-")),
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
        "owner session opens",
        20_000,
    );
    await page.evaluate(`document.querySelector('.topbar [aria-label="Menu"]').click()`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll('.nav-menu button')].some(item => item.textContent.includes('Subscription usage')))`,
            ),
        "owner subscription usage entry",
    );
    await page.evaluate(
        `[...document.querySelectorAll('.nav-menu button')].find(item => item.textContent.includes('Subscription usage')).click()`,
    );
    await until(
        async () => (await content()).includes("Claude test subscription"),
        "subscription quota sheet",
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
    "Fable usage is measured against its own cap and explains the shared weekly allowance",
    real,
    async () => {
        assert.equal((await meter("Weekly · All models used"))?.now, "61");
        const fable = await meter("Weekly · Fable used");

        assert.deepEqual(fable, { now: "2", text: "2% of Fable limit used", width: "2%" });
        const text = await content();

        assert.ok(text.includes("Weekly · All models"));
        assert.ok(text.includes("Weekly · Fable"));
        assert.ok(
            text.includes("Counts toward the shared weekly limit; Fable can use up to 50% of it."),
        );
        assert.ok(text.includes("Whichever limit is reached first applies."));
        assert.ok(text.includes("Fable usage accounts for 1% of the shared weekly limit."));
        const fableText = await inPage<string>(
            `return JSON.stringify(document.querySelector('${SHEET} [aria-label="Weekly · Fable used"]').parentElement.textContent)`,
        );

        assert.ok(fableText.includes("98% left"));
        assert.match(fableText, /Resets in 5d/);
        assert.equal(
            await inPage<number>(
                `return JSON.stringify(document.querySelectorAll('${SHEET} .subscription-reset').length)`,
            ),
            3,
        );
        await screenshot("fable-usage-desktop");
    },
);

test("an unreported weekly share never defaults to fifty percent", real, async () => {
    payload = fixture(fableWindow());
    await refresh();
    const text = await content();

    assert.ok(
        text.includes(
            "Counts toward the shared weekly limit. Whichever limit is reached first applies.",
        ),
    );
    assert.doesNotMatch(text, /can use up to|Fable usage accounts for/);
    assert.deepEqual(await meter("Weekly · Fable used"), {
        now: "2",
        text: "2% of Fable limit used",
        width: "2%",
    });
});

test(
    "reported allowance changes are respected instead of hard-coding the Fable share",
    real,
    async () => {
        payload = fixture(fableWindow({ allowancePercentOfWeekly: 20, usedPercentOfWeekly: 0.4 }));
        await refresh();
        const text = await content();

        assert.ok(text.includes("Fable can use up to 20% of it."));
        assert.ok(text.includes("Fable usage accounts for 0.4% of the shared weekly limit."));
        assert.doesNotMatch(text, /can use up to 50%/);
    },
);

test("unknown Fable usage displays its message without inventing a zero meter", real, async () => {
    payload = fixture(null, "Fable usage was not reported; no estimate is shown.");
    await refresh();
    const text = await content();

    assert.ok(text.includes("Fable usage was not reported; no estimate is shown."));
    assert.equal(await meter("Weekly · Fable used"), null);
    assert.equal(await meter("Weekly · All models used"), null);
    assert.equal((await meter("Weekly used"))?.now, "61");
    assert.equal(
        await inPage<number>(
            `return JSON.stringify(document.querySelectorAll('${SHEET} [role="progressbar"]').length)`,
        ),
        2,
    );
    assert.doesNotMatch(text, /0% of Fable|can use up to/);
});

test(
    "Fable cap, shared-weekly explanation and reset remain readable on a phone",
    real,
    async () => {
        payload = fixture(fableWindow({ allowancePercentOfWeekly: 50, usedPercentOfWeekly: 1 }));
        await refresh();
        await page.setViewport(PHONE);
        assert.equal(
            await inPage<boolean>(
                `const body = document.querySelector('${SHEET} .sheet-body'); return JSON.stringify(body.scrollWidth <= body.clientWidth && document.documentElement.scrollWidth <= innerWidth)`,
            ),
            true,
            "usage sheet fits the phone width",
        );
        assert.equal((await meter("Weekly · Fable used"))?.now, "2");
        await page.evaluate(
            `document.querySelector('${SHEET} [aria-label="Weekly · Fable used"]').scrollIntoView({ block: "nearest" })`,
        );
        await screenshot("fable-usage-mobile");
    },
);
