import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addFableUsage, createUsageHandler } from "../src/server/subscription-proxy.ts";
import type { SubscriptionAccount } from "../src/server/subscription-usage.ts";

const base = (): SubscriptionAccount => ({
    id: "rei-claude",
    name: "Test Claude",
    state: "ready",
    windows: [{ id: "seven_day", label: "Weekly", usedPercent: 40, resetAt: null }],
    checkedAt: "2026-11-09T20:00:00Z",
    nextCheckAt: "2026-11-09T20:05:00Z",
    stale: false,
});
const scoped = {
    id: "seven_day_fable",
    label: "Weekly · Fable",
    usedPercent: 12,
    resetAt: null,
    allowancePercentOfWeekly: 50,
    usedPercentOfWeekly: 6,
};

test("Fable supplementation preserves native shared limits through failed and stale scoped checks", () => {
    const original = base();
    const missing = addFableUsage(original, {
        ...base(),
        state: "unavailable",
        windows: [],
        message: "Provider unavailable",
    });

    assert.deepEqual(missing.windows, original.windows);
    assert.match(missing.fableMessage!, /could not be checked/);
    const unreported = addFableUsage(original, base());

    assert.match(unreported.fableMessage!, /did not report/);
    const stale = addFableUsage(original, {
        ...base(),
        state: "unavailable",
        stale: true,
        windows: [scoped],
        checkedAt: "2026-11-09T19:55:00Z",
    });

    assert.equal(stale.stale, true);
    assert.match(stale.fableMessage!, /last known/);
    assert.equal(stale.checkedAt, "2026-11-09T19:55:00Z");
    assert.deepEqual(stale.windows, [...original.windows, scoped]);
});

test("sidecar authorizes through native Pocket before reading credentials or contacting providers", async () => {
    let calls = 0;
    const server = createServer(
        createUsageHandler({
            upstream: "http://native",
            authFile: "/absent-secret-file",
            fetcher: async () => {
                calls++;

                return Response.json({ error: "Only owner" }, { status: 403 });
            },
        }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/subscription-usage`;

    try {
        const response = await fetch(url);

        assert.equal(response.status, 403);
        assert.equal(calls, 1);
    } finally {
        server.closeAllConnections();
        server.close();
    }
});

test("sidecar shows live scoped Fable usage without replacing shared quotas or exposing credentials; cache and identity are respected", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocket-fable-proxy-"));
    const authFile = join(root, "auth.json");
    const modelsFile = join(root, "models.json");
    const credentials = (access: string) => ({ "rei-claude": { type: "oauth", access } });

    await writeFile(authFile, JSON.stringify(credentials("sk-ant-oat-fabricated-first")));
    await writeFile(
        modelsFile,
        JSON.stringify({
            providers: {
                "rei-claude": { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
            },
        }),
    );
    let calls = 0;
    const upstreamAccount = base();
    const handler = createUsageHandler({
        upstream: "http://native",
        authFile,
        modelsFile,
        now: () => Date.parse("2026-11-09T20:00:00Z"),
        fetcher: async (input, options) => {
            if (String(input).startsWith("http://native/")) {
                assert.equal(options?.redirect, "error");
                assert.equal(
                    (options?.headers as Record<string, string>).authorization,
                    "Bearer fabricated-owner",
                );

                return Response.json({ accounts: [upstreamAccount] });
            }

            calls++;
            assert.equal(String(input), "https://api.anthropic.com/api/oauth/usage");
            assert.match(
                (options?.headers as Record<string, string>).Authorization!,
                /^Bearer sk-ant-oat-fabricated-/,
            );

            return Response.json({
                limits: [
                    { kind: "weekly_all", percent: 99 },
                    {
                        kind: "weekly_scoped",
                        percent: calls,
                        scope: { model: { display_name: "Fable" } },
                    },
                ],
                weekly_scoped_shares: [
                    { limit_index: 1, used_percent_of_weekly: 1, allowance_percent_of_weekly: 50 },
                ],
                private_account: "must-not-escape",
            });
        },
    });
    const server = createServer(handler);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/subscription-usage`;

    const read = async () => {
        const response = await fetch(url, {
            headers: { authorization: "Bearer fabricated-owner" },
        });

        assert.equal(response.status, 200);

        return response.json() as Promise<{ accounts: SubscriptionAccount[] }>;
    };

    try {
        const first = await read();
        const account = first.accounts.find((account) => account.id === "rei-claude")!;

        assert.equal(account.windows[0]!.usedPercent, 40);
        assert.equal(account.windows[1]!.usedPercent, 1);
        assert.equal(account.windows[1]!.allowancePercentOfWeekly, 50);
        assert.doesNotMatch(JSON.stringify(first), /sk-ant|must-not-escape|fabricated-owner/);
        await read();
        assert.equal(calls, 1);
        await writeFile(authFile, JSON.stringify(credentials("sk-ant-oat-fabricated-second")));
        const changed = await read();

        assert.equal(calls, 2);
        assert.equal(
            changed.accounts.find((account) => account.id === "rei-claude")!.windows[1]!
                .usedPercent,
            2,
        );
    } finally {
        server.closeAllConnections();
        server.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("unreadable Claude configuration cannot break native limits or Kimi and Go", async () => {
    for (const scenario of ["missing", "invalid-json", "invalid-url"]) {
        const root = await mkdtemp(join(tmpdir(), "pocket-fable-isolation-"));
        const authFile = join(root, "auth.json");
        const modelsFile = join(root, "models.json");

        await writeFile(
            authFile,
            JSON.stringify({
                "rei-claude": { type: "oauth", access: "sk-ant-oat-fabricated" },
                "kimi-coding": { type: "api_key", key: "fabricated-kimi" },
                "opencode-go": { type: "api_key", key: "fabricated-go" },
            }),
        );

        if (scenario === "invalid-json") {
            await writeFile(modelsFile, "{");
        } else if (scenario === "invalid-url") {
            await writeFile(
                modelsFile,
                JSON.stringify({
                    providers: {
                        "rei-claude": { api: "anthropic-messages", baseUrl: "invalid URL" },
                    },
                }),
            );
        }

        const requests: string[] = [];
        const server = createServer(
            createUsageHandler({
                upstream: "http://native",
                authFile,
                modelsFile,
                fetcher: async (input) => {
                    const url = String(input);

                    if (url.startsWith("http://native/")) {
                        return Response.json({ accounts: [base()] });
                    }

                    requests.push(url);

                    return Response.json(
                        url.includes("kimi")
                            ? { usages: { limit_5h: { used_ratio: 0.4 } } }
                            : { usage: { weekly: { percent: 20 } } },
                    );
                },
            }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

        try {
            const response = await fetch(
                `http://127.0.0.1:${(server.address() as { port: number }).port}/api/subscription-usage`,
            );
            const data = (await response.json()) as { accounts: SubscriptionAccount[] };

            assert.equal(response.status, 200, scenario);
            const claude = data.accounts.find((account) => account.id === "rei-claude")!;

            assert.deepEqual(claude.windows, base().windows);
            assert.match(claude.fableMessage!, /temporarily unavailable/);
            assert.equal(
                data.accounts.find((account) => account.id === "kimi-coding")!.windows[0]!
                    .usedPercent,
                40,
            );
            assert.equal(
                data.accounts.find((account) => account.id === "opencode-go")!.windows[0]!
                    .usedPercent,
                20,
            );
            assert.equal(requests.length, 2);
        } finally {
            server.closeAllConnections();
            server.close();
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("failed supplemental checks preserve a Fable limit already supplied by native Pocket", () => {
    const native = { ...base(), windows: [...base().windows, scoped] };
    const result = addFableUsage(native, { ...base(), state: "unavailable", windows: [] });

    assert.deepEqual(result, native);
});
