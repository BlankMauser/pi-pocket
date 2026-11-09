import assert from "node:assert/strict";
import test from "node:test";
import {
    claudeWindows,
    codexWindows,
    kimiWindows,
    opencodeGoWindows,
    SubscriptionUsage,
} from "../src/server/subscription-usage.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const raw = {
    five_hour: { utilization: 29, resets_at: "2026-10-15T22:29:59Z" },
    seven_day: { utilization: 35, resets_at: null },
    private_account_data: "must-not-escape",
    seven_day_opus: null,
};

function fixture(fetcher: typeof fetch, codex = false) {
    let now = Date.parse("2026-10-15T20:00:00Z"),
        authCalls = 0;
    const access = codex
        ? `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "selected-account" } })).toString("base64url")}.signature`
        : "sk-ant-oat-test-secret";
    const id = codex ? "codex-test" : "claude-test";
    const models = {
        getProviders: () => [{ id, name: "Test account" }],
        getModels: () => [],
        getProviderAuthStatus: () => ({ configured: true }),
        getAuth: async () => {
            authCalls++;

            return { auth: { apiKey: access } };
        },
    } as unknown as ModelRuntime;
    const usage = new SubscriptionUsage(
        () => models,
        fetcher,
        () => now,
    );

    return {
        usage,
        models,
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
        calls: () => authCalls,
    };
}

test("parsers expose only reported finite quotas, classify single Codex weekly window correctly", () => {
    assert.deepEqual(claudeWindows(raw), [
        {
            id: "five_hour",
            label: "Five hours",
            usedPercent: 29,
            resetAt: "2026-10-15T22:29:59.000Z",
        },
        { id: "seven_day", label: "Weekly", usedPercent: 35, resetAt: null },
    ]);
    assert.deepEqual(
        claudeWindows({ five_hour: { utilization: NaN }, seven_day: { utilization: -1 } }),
        [],
    );
    assert.equal(
        codexWindows({
            rate_limit: {
                primary_window: {
                    used_percent: 7,
                    limit_window_seconds: 604800,
                    reset_at: 1790000000,
                },
                secondary_window: null,
            },
        })[0]?.label,
        "Weekly",
    );
});
test("concurrent checks share native auth and one provider request; secrets never reach response", async () => {
    let calls = 0;
    const f = fixture(async (url, options) => {
        calls++;
        assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
        assert.equal(options?.redirect, "error");
        assert.equal(
            (options?.headers as Record<string, string>).Authorization!,
            "Bearer sk-ant-oat-test-secret",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));

        return Response.json(raw);
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () => f.usage.summary()));

    assert.equal(calls, 1);
    assert.equal(f.calls(), 1);
    assert.ok(responses.every((response) => response.accounts[0]?.state === "ready"));
    assert.doesNotMatch(JSON.stringify(responses), /sk-ant|private_account|must-not-escape/);
    await f.usage.summary();
    assert.equal(calls, 1);
});
test("provider cooldown preserves last-known usage without pretending a reset cleared it", async () => {
    let calls = 0;
    const f = fixture(async () =>
        ++calls === 1
            ? Response.json(raw)
            : new Response("private upstream content", {
                  status: 429,
                  headers: { "retry-after": "900" },
              }),
    );
    const initial = await f.usage.summary();

    f.advance(300001);
    const retry = (await f.usage.summary()).accounts[0]!;

    assert.equal(retry.stale, true);
    assert.deepEqual(retry.windows, initial.accounts[0]?.windows);
    assert.match(retry.message!, /rate limited/);
    f.advance(600000);
    await f.usage.summary();
    assert.equal(calls, 2);
    f.advance(3000001);
    const expired = (await f.usage.summary()).accounts[0]!;

    assert.deepEqual(expired.windows, []);
    assert.equal(expired.stale, false);
});
test("Codex requests select the correct account", async () => {
    const f = fixture(async (url, options) => {
        assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
        assert.equal(
            (options?.headers as Record<string, string>)["ChatGPT-Account-Id"],
            "selected-account",
        );

        return Response.json({
            rate_limit: {
                primary_window: {
                    used_percent: 15,
                    limit_window_seconds: 18000,
                    reset_at: 1790000000,
                },
            },
        });
    }, true);

    assert.equal((await f.usage.summary()).accounts[0]?.state, "ready");
});
test("auth failures are redacted and cached; account changes invalidate cache", async () => {
    const f = fixture(async () => {
        throw new Error("The provider leaked sk-ant-secret");
    });
    const failed = await f.usage.summary();

    assert.doesNotMatch(JSON.stringify(failed), /sk-ant/);
    assert.equal(failed.accounts[0]?.state, "unavailable");
    await f.usage.summary();
    assert.equal(f.calls(), 1);
    f.usage.clear();
    await f.usage.summary();
    assert.equal(f.calls(), 2);
});

test("subscription usage route is owner-only", async () => {
    const { createApi } = await import("../src/server/http/api.ts");
    let role: string | undefined = "viewer",
        calls = 0,
        output = "";
    const app: any = {
        providers: {
            subscriptionUsage: async () => {
                calls++;

                return { accounts: [] };
            },
        },
    };
    const auth: any = { user: () => (role ? { id: "test", role } : undefined) };
    const handler = createApi({ app } as any, auth);
    const request: any = { method: "GET", headers: { host: "localhost" } };
    const response: any = {
        writeHead() {},
        end(value: string) {
            output = value;
        },
    };

    for (const who of ["viewer", "guest", undefined]) {
        role = who;
        await assert.rejects(
            handler(request, response, new URL("http://localhost/api/subscription-usage"), [
                "subscription-usage",
            ]),
            (error: any) => error.status === (who ? 403 : 401),
        );
    }

    assert.equal(calls, 0);
    role = "owner";
    await handler(request, response, new URL("http://localhost/api/subscription-usage"), [
        "subscription-usage",
    ]);
    assert.deepEqual(JSON.parse(output), { accounts: [] });
    assert.equal(calls, 1);
});

test("API gateways are not mistaken for Claude subscription accounts", async () => {
    const f = fixture(async () => {
        throw new Error("No usage request should run");
    });

    f.models.getProviders = () => [{ id: "generic-gateway", name: "Gateway" }] as any;
    f.models.getModels = () =>
        [{ api: "anthropic-messages", baseUrl: "https://opencode.ai/zen" }] as any;
    assert.deepEqual((await f.usage.summary()).accounts, []);
    assert.equal(f.calls(), 0);
});

test("Kimi and OpenCode Go retain their quota windows and omit private fields", () => {
    assert.deepEqual(opencodeGoWindows({ usage: { weekly: { percent: 80 } }, private: "omit" }), [
        { id: "weekly", label: "Weekly", usedPercent: 80, resetAt: null },
    ]);
    assert.deepEqual(
        kimiWindows({
            usages: { limit_5h: { used_ratio: "0.25" }, limit_month_code: { used_ratio: 0.9 } },
        }),
        [{ id: "limit_5h", label: "Five hours", usedPercent: 25, resetAt: null }],
    );
    assert.equal(
        kimiWindows({
            limits: [
                {
                    window: { timeUnit: "TIME_UNIT_MINUTE", duration: 300 },
                    detail: { used: 5, limit: 20 },
                },
            ],
        })[0]?.usedPercent,
        25,
    );
});

test("native Kimi and OpenCode Go usage is cached, authenticated and excludes credentials", async () => {
    const requests: string[] = [];
    const ids = ["opencode-go", "kimi-coding"];
    const models = {
        getProviders: () => ids.map((id) => ({ id, name: id })),
        getModels: () => [],
        getProviderAuthStatus: () => ({ configured: true }),
        getAuth: async (id: string) => ({ auth: { apiKey: `synthetic-${id}` } }),
    } as unknown as ModelRuntime;
    const usage = new SubscriptionUsage(
        () => models,
        async (url, options) => {
            requests.push(String(url));
            assert.equal(options?.redirect, "error");
            assert.match(
                (options?.headers as Record<string, string>).Authorization!,
                /^Bearer synthetic-/,
            );

            return Response.json(
                String(url).includes("kimi")
                    ? { usages: { limit_5h: { used_ratio: 0.4 } } }
                    : { usage: { weekly: { percent: 70 } } },
            );
        },
    );
    const result = await usage.summary();

    assert.deepEqual(
        result.accounts.map((account) => account.id),
        ids,
    );
    assert.ok(result.accounts.every((account) => account.state === "ready"));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-/);
    assert.deepEqual(
        requests.sort(),
        ["https://api.kimi.com/coding/v1/usages", "https://opencode.ai/zen/go/v1/usage"].sort(),
    );
    await usage.summary();
    assert.equal(requests.length, 2);
});

test("Claude modern Fable limits use scoped percentages and original share indices, even when not binding", () => {
    const payload = {
        seven_day: { utilization: 99, resets_at: null },
        limits: [
            { kind: "ignored", percent: 91 },
            { kind: "session", percent: 15, resets_at: "2026-11-10T02:00:00Z" },
            { kind: "weekly_all", percent: 40, resets_at: "2026-11-16T09:00:00Z" },
            {
                kind: "weekly_scoped",
                percent: 12,
                is_active: false,
                resets_at: "2026-11-16T09:00:00Z",
                scope: { model: { id: null, display_name: "Fable" } },
            },
        ],
        weekly_scoped_shares: [
            { limit_index: 3, used_percent_of_weekly: 6, allowance_percent_of_weekly: 50 },
        ],
        private_account_data: "must-not-escape",
    };
    const windows = claudeWindows(payload);

    assert.deepEqual(
        windows.map((window) => [window.id, window.usedPercent]),
        [
            ["five_hour", 15],
            ["seven_day", 40],
            ["seven_day_fable", 12],
        ],
    );
    assert.deepEqual(windows[2], {
        id: "seven_day_fable",
        label: "Weekly · Fable",
        usedPercent: 12,
        resetAt: "2026-11-16T09:00:00.000Z",
        allowancePercentOfWeekly: 50,
        usedPercentOfWeekly: 6,
    });
    assert.doesNotMatch(JSON.stringify(windows), /must-not-escape/);
});

test("Claude scoped quotas preserve reported zero and never invent a missing Fable quota or share", () => {
    assert.deepEqual(
        claudeWindows({
            limits: [
                { kind: "weekly_scoped", percent: 0, scope: { model: { id: "claude-fable-5-2" } } },
            ],
        }),
        [{ id: "seven_day_fable", label: "Weekly · Fable", usedPercent: 0, resetAt: null }],
    );
    assert.deepEqual(claudeWindows({ seven_day_fable: { utilization: 25 } }), [
        { id: "seven_day_fable", label: "Weekly · Fable", usedPercent: 25, resetAt: null },
    ]);
    assert.deepEqual(
        claudeWindows({
            limits: [
                {
                    kind: "weekly_scoped",
                    percent: null,
                    scope: { model: { display_name: "Fable" } },
                },
                {
                    kind: "weekly_scoped",
                    percent: Infinity,
                    scope: { model: { display_name: "Fable" } },
                },
                { kind: "weekly_scoped", percent: -2, scope: { model: { display_name: "Fable" } } },
                {
                    kind: "weekly_scoped",
                    percent: 12,
                    scope: { model: { display_name: "Something else" } },
                },
            ],
        }),
        [],
    );
});
