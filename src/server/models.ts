/** Models as browsers see them: the ones available, the one a conversation runs with, and finding one by name. */
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentState, ModelRef } from "@earendil-works/pi-durable";
import { supportsFast } from "./fast-mode.ts";

type ModelSummary = {
    provider: string;
    id: string;
    name: string;
    contextWindow: number;
    reasoning: boolean;
    images: boolean;
    levels: string[];
};

/** Whether a model thinks, and at which levels, and whether it takes images. */
function capabilities(model: Model<Api>) {
    return {
        reasoning: model.reasoning === true,
        images: model.input.includes("image"),
        levels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"],
    };
}

/** The models people can pick: the ones with a configured sign-in. */
export function modelList(models: ModelRuntime): ModelSummary[] {
    return models.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        ...capabilities(model),
    }));
}

/** Compare model-name tokens independent of their order, retaining version numbers. */
function modelDistance(left: string, right: string): number {
    const tokens = (value: string) =>
        (value.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g) ?? []).sort().join("-");
    const a = tokens(left);
    const b = tokens(right);
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0]!;

        row[0] = i;

        for (let j = 1; j <= b.length; j++) {
            const previous = row[j]!;

            row[j] = Math.min(
                row[j]! + 1,
                row[j - 1]! + 1,
                diagonal + Number(a[i - 1] !== b[j - 1]),
            );
            diagonal = previous;
        }
    }

    return row[b.length]!;
}

/** An available model by `provider/id`, or by id alone. Never silently switch accounts. */
export function resolveModel(models: ModelRuntime, spec: string): ModelRef {
    const trimmed = spec.trim();
    const available = models.getAvailableSnapshot();
    const slash = trimmed.indexOf("/");
    const found =
        slash > 0
            ? available.find(
                  (model) =>
                      model.provider === trimmed.slice(0, slash) &&
                      model.id === trimmed.slice(slash + 1),
              )
            : available.find((model) => model.id === trimmed);

    if (found === undefined) {
        const provider = slash > 0 ? trimmed.slice(0, slash) : undefined;
        const id = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
        const suggestions = available
            .filter((model) => provider === undefined || model.provider === provider)
            .map((model) => ({ model, distance: modelDistance(id, model.id) }))
            .filter(({ distance }) => distance <= Math.max(1, Math.floor(id.length / 4)))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 3)
            .map(({ model }) => `${model.provider}/${model.id}`);
        // Show the requested account first, but include the complete catalog: a global cap hid custom providers.
        const names = [...available]
            .sort((a, b) => Number(b.provider === provider) - Number(a.provider === provider))
            .map((model) => `${model.provider}/${model.id}`);

        throw new Error(
            `Model ${spec} is not available.` +
                (suggestions.length === 0 ? "" : ` Did you mean: ${suggestions.join(", ")}?`) +
                `\nAvailable models (${names.length}):\n${names.length === 0 ? "None. Add or sign in to a provider." : names.join("\n")}`,
        );
    }

    return { provider: found.provider, modelId: found.id };
}

/** What a conversation runs with, for its view: its model and what the model can do, thinking, folder, instructions. */
export function agentInfo(models: ModelRuntime, agent: AgentState, defaultCwd: string) {
    const model =
        agent.model === undefined
            ? undefined
            : models.getModel(agent.model.provider, agent.model.modelId);

    return {
        model: agent.model ?? null,
        thinkingLevel: agent.thinkingLevel ?? "off",
        cwd: agent.cwd ?? defaultCwd,
        ...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
        available: model !== undefined && models.hasConfiguredAuth(model.provider),
        fastCapable: supportsFast(model),
        ...(model === undefined
            ? {}
            : {
                  modelName: model.name,
                  contextWindow: model.contextWindow,
                  ...capabilities(model),
              }),
    };
}
