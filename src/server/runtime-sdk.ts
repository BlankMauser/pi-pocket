/** Live extensions share the compiled app's SDK so they use the same task and document registries. */
const native = (
    globalThis as typeof globalThis & {
        __piPocketRuntime?: { modules: Record<string, unknown> };
    }
).__piPocketRuntime;

export const aiSdk = (native?.modules["@earendil-works/pi-ai"] ??
    (await import("@earendil-works/pi-ai"))) as typeof import("@earendil-works/pi-ai");
export const durableSdk = (native?.modules["@earendil-works/pi-durable"] ??
    (await import("@earendil-works/pi-durable"))) as typeof import("@earendil-works/pi-durable");
export const codingAgentSdk = (native?.modules["@earendil-works/pi-coding-agent"] ??
    (await import("@earendil-works/pi-coding-agent"))) as typeof import("@earendil-works/pi-coding-agent");

/** Pi 1.5 moved runtime tool schemas out of pi-ai. */
export const schemaSdk = (native?.modules["@earendil-works/pi-schema"] ??
    (await import("@earendil-works/pi-schema"))) as typeof import("@earendil-works/pi-schema");
