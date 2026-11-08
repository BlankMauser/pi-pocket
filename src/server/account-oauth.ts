/** Native OAuth for explicitly configured Claude and Codex account aliases. */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

function configuredIds(name: string): string[] {
    return (process.env[name] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
}

export function installAccountOAuth(
    models: ModelRuntime,
    providerIds = configuredIds("PI_POCKET_ANTHROPIC_OAUTH_PROVIDERS"),
    codexIds = configuredIds("PI_POCKET_CODEX_OAUTH_PROVIDERS"),
): void {
    const groups = [
        { baseId: "anthropic", api: "anthropic-messages", ids: providerIds },
        { baseId: "openai-codex", api: "openai-codex-responses", ids: codexIds },
    ];
    const seen = new Set<string>();

    for (const { baseId, api, ids } of groups) {
        if (ids.length === 0) {
            continue;
        }

        const base = models.getProvider(baseId);

        if (!base?.auth.oauth) {
            throw new Error(`${baseId} OAuth is unavailable for the configured account aliases`);
        }

        for (const id of new Set(ids)) {
            const existing = models.getProvider(id);
            const catalog = models.getModels(id);

            if (
                groups.some((group) => group.baseId === id) ||
                seen.has(id) ||
                !existing ||
                catalog.length === 0 ||
                catalog.some((model) => model.api !== api)
            ) {
                throw new Error(`Invalid ${baseId} OAuth account alias: ${id}`);
            }

            seen.add(id);
            models.registerNativeProvider({
                ...base,
                id,
                name: existing.name,
                getModels: () => catalog,
                getAllModels: () => catalog,
                refreshModels: undefined,
            });
        }
    }
}
