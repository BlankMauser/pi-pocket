/** Offline compatibility check required before activating a hosted Pocket update. */
import assert from "node:assert/strict";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installAccountOAuth } from "./account-oauth.ts";

export async function checkAccountOAuth() {
    const credentials = new InMemoryCredentialStore();
    const models = await ModelRuntime.create({
        credentials,
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        refreshOnCreate: false,
    });

    for (const [baseId, id] of [
        ["anthropic", "claude-duriel"],
        ["openai-codex", "codex-zack"],
    ] as const) {
        const base = models.getProvider(baseId);

        assert.ok(base?.auth.oauth);
        const catalog = base
            .getModels()
            .slice(0, 1)
            .map((model) => ({ ...model, provider: id }));

        assert.equal(catalog.length, 1);
        models.registerNativeProvider({
            ...base,
            id,
            getModels: () => catalog,
            getAllModels: () => catalog,
        });
        installAccountOAuth(
            models,
            baseId === "anthropic" ? [id] : [],
            baseId === "openai-codex" ? [id] : [],
        );
        assert.equal(models.getProvider(id)?.auth.oauth?.login, base.auth.oauth.login);
        assert.deepEqual(models.getModels(id), catalog);
        let refreshes = 0;

        models.registerNativeProvider({
            ...models.getProvider(id)!,
            auth: {
                ...base.auth,
                oauth: {
                    ...base.auth.oauth,
                    refresh: async () => {
                        refreshes++;

                        return {
                            type: "oauth",
                            access: "synthetic-fresh",
                            refresh: "synthetic-rotated",
                            expires: Date.now() + 3_600_000,
                        };
                    },
                    toAuth: async (credential) => ({ apiKey: credential.access }),
                },
            },
        });
        await credentials.modify(id, async () => ({
            type: "oauth",
            access: "synthetic-expired",
            refresh: "synthetic-old",
            expires: 0,
        }));
        const resolved = await Promise.all(Array.from({ length: 8 }, () => models.getAuth(id)));

        assert.equal(refreshes, 1);
        assert.ok(resolved.every((auth) => auth?.auth.apiKey === "synthetic-fresh"));
        assert.deepEqual(models.getModels(id), catalog);
    }

    return {
        feature: "account-oauth",
        version: 1,
        login: true,
        refresh: true,
        modelsUnchanged: true,
    };
}
