import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    InMemoryCredentialStore,
    InMemoryModelsStore,
    normalizeContext,
    type OAuthCredential,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installAccountOAuth } from "../src/server/account-oauth.ts";

const alias = "claude-duriel";
const credential = (access: string, expires = Date.now() + 3_600_000): OAuthCredential => ({
    type: "oauth",
    access,
    refresh: "test-refresh",
    expires,
});

async function fixture(t: test.TestContext) {
    const dir = await mkdtemp(join(tmpdir(), "pocket-account-oauth-"));

    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "models.json");

    await writeFile(
        path,
        JSON.stringify({
            providers: {
                [alias]: {
                    api: "anthropic-messages",
                    baseUrl: "https://api.anthropic.com",
                    models: [
                        {
                            id: "claude-opus-5-5",
                            name: "Claude Opus 5.5",
                            reasoning: true,
                            input: ["text", "image"],
                            contextWindow: 200000,
                            maxTokens: 32000,
                        },
                    ],
                },
            },
        }),
    );
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
        credentials,
        modelsStore: new InMemoryModelsStore(),
        modelsPath: path,
        refreshOnCreate: false,
    });
    const base = runtime.getProviders().find((provider) => provider.id === "anthropic")!;

    return { runtime, credentials, base };
}

test("alias offers the same OAuth handler and preserves every existing model field", async (t) => {
    const { runtime, base } = await fixture(t);
    const before = structuredClone(runtime.getModels(alias));

    installAccountOAuth(runtime, [alias]);
    const provider = runtime.getProviders().find((item) => item.id === alias)!;

    assert.equal(provider.auth.oauth?.name, base.auth.oauth?.name);
    assert.equal(provider.auth.oauth?.isSubscription, true);
    assert.ok(provider.auth.oauth?.login);
    assert.deepEqual(runtime.getModels(alias), before);
});

test("OAuth login writes only the alias and logout cannot fall back to the old helper", async (t) => {
    const { runtime, credentials, base } = await fixture(t);

    await credentials.modify("unrelated", async () => ({ type: "api_key", key: "keep-me" }));
    runtime.registerNativeProvider({
        ...base,
        auth: {
            ...base.auth,
            oauth: {
                ...base.auth.oauth!,
                login: async () => credential("login-token"),
            },
        },
    });
    installAccountOAuth(runtime, [alias]);
    await runtime.login(alias, "oauth", {
        signal: new AbortController().signal,
        prompt: async () => "",
        notify: () => {},
    });
    assert.equal((await credentials.read(alias))?.type, "oauth");
    assert.deepEqual(await credentials.read("unrelated"), { type: "api_key", key: "keep-me" });
    await runtime.logout(alias);
    assert.equal(await runtime.getAuth(alias), undefined);
});

test("concurrent requests after overnight expiry refresh once in the same runtime", async (t) => {
    const { runtime, credentials, base } = await fixture(t);
    let refreshes = 0;

    runtime.registerNativeProvider({
        ...base,
        auth: {
            ...base.auth,
            oauth: {
                ...base.auth.oauth!,
                refresh: async () => {
                    refreshes++;
                    await new Promise((resolve) => setTimeout(resolve, 30));

                    return credential("fresh-token");
                },
                toAuth: async (stored) => ({ apiKey: stored.access }),
            },
        },
    });
    installAccountOAuth(runtime, [alias]);
    await credentials.modify(alias, async () => credential("old-token"));
    assert.equal((await runtime.getAuth(alias))?.auth.apiKey, "old-token");
    await credentials.modify(alias, async () =>
        credential("old-token", Date.now() - 12 * 3_600_000),
    );
    const results = await Promise.all(Array.from({ length: 12 }, () => runtime.getAuth(alias)));

    assert.equal(refreshes, 1);
    assert.ok(results.every((result) => result?.auth.apiKey === "fresh-token"));
    assert.equal((await runtime.getAuth(alias))?.auth.apiKey, "fresh-token");
    assert.equal(refreshes, 1);
});

test(
    "a refresh exceeding the former shell timeout completes and saves its rotation",
    { timeout: 20_000 },
    async (t) => {
        const { runtime, credentials, base } = await fixture(t);

        runtime.registerNativeProvider({
            ...base,
            auth: {
                ...base.auth,
                oauth: {
                    ...base.auth.oauth!,
                    refresh: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 10_100));

                        return { ...credential("slow-fresh-token"), refresh: "rotated-refresh" };
                    },
                    toAuth: async (stored) => ({ apiKey: stored.access }),
                },
            },
        });
        installAccountOAuth(runtime, [alias]);
        await credentials.modify(alias, async () => credential("expired-token", 0));
        assert.equal((await runtime.getAuth(alias))?.auth.apiKey, "slow-fresh-token");
        assert.deepEqual(await credentials.read(alias), {
            ...(await credentials.read(alias)),
            access: "slow-fresh-token",
            refresh: "rotated-refresh",
        });
    },
);

test("OAuth registration keeps the outgoing prompt, cache controls and session affinity identical", async (t) => {
    const { runtime } = await fixture(t);
    const model = runtime.getModels(alias)[0]!;
    const context = normalizeContext({
        systemPrompt: "Keep this stable system prompt.",
        messages: [{ role: "user" as const, content: "Stable conversation history", timestamp: 1 }],
    });
    const payloads: unknown[] = [];

    const capture = async () => {
        const provider = runtime.getProvider(alias)!;
        const result = provider.streamSimple(model, context, {
            apiKey: "sk-ant-oat01-dummy-test-credential",
            sessionId: "existing-session-id",
            cacheRetention: "long",
            maxTokens: 16,
            onPayload: (payload) => {
                payloads.push(structuredClone(payload));

                throw new Error("request captured before network");
            },
        });

        await result.result();
    };

    await capture();
    installAccountOAuth(runtime, [alias]);
    await capture();
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[1], payloads[0]);
    assert.ok(JSON.stringify(payloads[0]).includes("cache_control"));
});

async function codexFixture(t: test.TestContext) {
    const { runtime, credentials } = await fixture(t);
    const base = runtime.getProvider("openai-codex")!;
    const id = "codex-zack";
    const catalog = base
        .getModels()
        .slice(0, 2)
        .map((model) => ({ ...model, provider: id }));

    assert.ok(base.auth.oauth);
    assert.equal(catalog.length, 2);
    runtime.registerNativeProvider({
        ...base,
        id,
        getModels: () => catalog,
        getAllModels: () => catalog,
        auth: {},
    });

    return { runtime, credentials, base, id, catalog };
}

test("Codex alias uses native login, refresh and logout while keeping its model catalog", async (t) => {
    const { runtime, credentials, base, id, catalog } = await codexFixture(t);
    let refreshes = 0;

    runtime.registerNativeProvider({
        ...base,
        auth: {
            ...base.auth,
            oauth: {
                ...base.auth.oauth!,
                login: async () => ({ ...credential("codex-login", 0), accountId: "zach-account" }),
                refresh: async () => {
                    refreshes++;

                    return { ...credential("codex-fresh"), accountId: "zach-account" };
                },
                toAuth: async (stored) => ({
                    apiKey: stored.access,
                    headers: { "chatgpt-account-id": String(stored.accountId) },
                }),
            },
        },
    });
    installAccountOAuth(runtime, [alias], [id]);
    assert.deepEqual(runtime.getModels(id), catalog);
    await credentials.modify("other-account", async () => credential("unchanged"));
    await runtime.login(id, "oauth", {
        signal: new AbortController().signal,
        prompt: async () => "",
        notify: () => {},
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => runtime.getAuth(id)));

    assert.equal(refreshes, 1);
    assert.ok(results.every((result) => result?.auth.apiKey === "codex-fresh"));
    assert.equal(results[0]?.auth.headers?.["chatgpt-account-id"], "zach-account");
    const unrelated = await credentials.read("other-account");

    assert.equal(unrelated?.type === "oauth" && unrelated.access, "unchanged");
    assert.deepEqual(runtime.getModels(id), catalog);
    await runtime.logout(id);
    assert.equal(await runtime.getAuth(id), undefined);
});

test("OAuth alias rejects wrong model families and native provider replacement", async (t) => {
    const { runtime, id } = await codexFixture(t);

    assert.throws(() => installAccountOAuth(runtime, [], [alias]), /Invalid openai-codex/);
    assert.throws(() => installAccountOAuth(runtime, [id], []), /Invalid anthropic/);
    assert.throws(() => installAccountOAuth(runtime, [], ["openai-codex"]), /Invalid openai-codex/);
});
