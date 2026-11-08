/** OpenAI "Fast" (priority) service tier. pi-ai's simple options drop `serviceTier`, so it is set on the request body. */
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The OpenAI APIs that accept `service_tier`: ChatGPT/Codex subscription sign-ins and OpenAI API keys. */
const FAST_APIS = new Set<string>(["openai-codex-responses", "openai-responses"]);

export const supportsFast = (model: Pick<Model<Api>, "api"> | undefined): boolean =>
    model !== undefined && FAST_APIS.has(model.api);

/** Ask for the priority tier, keeping any request-body change another `onPayload` already made. */
export function withPriority(options: SimpleStreamOptions = {}): SimpleStreamOptions {
    const earlier = options.onPayload;

    return {
        ...options,
        onPayload: async (body, model) => {
            const next = (await earlier?.(body, model)) ?? body;

            return supportsFast(model) ? { ...(next as object), service_tier: "priority" } : next;
        },
    };
}

/** Make every OpenAI request this runtime streams use the priority tier while `enabled()` is true. */
export function installFastMode(models: ModelRuntime, enabled: () => boolean): void {
    const stream = models.streamSimple.bind(models);

    (models as { streamSimple: ModelRuntime["streamSimple"] }).streamSimple = (
        model,
        context,
        options,
    ) => stream(model, context, enabled() && supportsFast(model) ? withPriority(options) : options);
}
