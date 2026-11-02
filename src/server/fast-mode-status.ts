/** Read the owner's existing Fast switch for extension prompts and tool results, without changing it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function openAiFastEnabled(dataDir: string): boolean | undefined {
    try {
        const config: unknown = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));

        if (config === null || typeof config !== "object" || Array.isArray(config)) {
            return undefined;
        }

        return (config as { openaiFast?: unknown }).openaiFast === true;
    } catch {
        return undefined;
    }
}

export function openAiFastStatus(dataDir: string) {
    const enabled = openAiFastEnabled(dataDir);

    return {
        enabled: enabled ?? null,
        scope: "OpenAI Responses/Codex requests",
        requestedTier: enabled === true ? "priority" : null,
    };
}

export function openAiFastSummary(status: ReturnType<typeof openAiFastStatus>): string {
    if (status.enabled === null) {
        return "OpenAI Fast: server setting unavailable; do not assume Standard or Fast.";
    }

    return status.enabled
        ? "OpenAI Fast requested (priority) for OpenAI subagents, inherited from the server switch; other providers are unaffected. Provider delivery is not verified."
        : "OpenAI Fast: disabled by the server switch; the owner can enable it in Pi Pocket.";
}

export function openAiFastPrompt(dataDir: string): string {
    const enabled = openAiFastEnabled(dataDir);
    const state = enabled === undefined ? "unavailable" : enabled ? "enabled" : "disabled";

    return `OpenAI Fast mode on this server: ${state}. This owner-controlled switch applies to every OpenAI Responses/Codex conversation, including existing and newly spawned subagents, even when the parent uses Claude or another provider. When enabled, the server requests service_tier="priority" automatically. There is no separate fast model name or subagent speed argument. Do not infer Standard speed from the absence of such an argument. This describes the requested tier, not a guarantee of provider delivery. When disabled, the owner can turn it on in Pi Pocket's settings.`;
}
