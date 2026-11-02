/** Provider-reported subscription quotas. Credentials stay in the native model runtime. */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type UsageWindow = {
    id: string;
    label: string;
    usedPercent: number;
    resetAt: string | null;
};
export type SubscriptionAccount = {
    id: string;
    name: string;
    state: "ready" | "unavailable" | "unsupported" | "signed_out";
    windows: UsageWindow[];
    checkedAt: string | null;
    nextCheckAt: string;
    stale: boolean;
    message?: string;
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as ObjectValue)
        : {};
const percent = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

const iso = (value: unknown): string | null => {
    const milliseconds =
        typeof value === "number"
            ? value * 1000
            : typeof value === "string"
              ? Date.parse(value)
              : NaN;

    return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds < 8.64e15
        ? new Date(milliseconds).toISOString()
        : null;
};

const CLAUDE_WINDOWS: Record<string, string> = {
    five_hour: "Five hours",
    seven_day: "Weekly",
    seven_day_opus: "Weekly · Opus",
    seven_day_sonnet: "Weekly · Sonnet",
    seven_day_oauth_apps: "Weekly · OAuth apps",
    seven_day_cowork: "Weekly · Cowork",
};

export function claudeWindows(payload: unknown): UsageWindow[] {
    const data = object(payload);

    return Object.entries(CLAUDE_WINDOWS).flatMap(([id, label]) => {
        const window = object(data[id]);

        return percent(window.utilization)
            ? [{ id, label, usedPercent: window.utilization, resetAt: iso(window.resets_at) }]
            : [];
    });
}

export function codexWindows(payload: unknown): UsageWindow[] {
    const data = object(payload);
    const rate = object(data.rate_limit ?? data.rate_limits);

    return ["primary_window", "secondary_window"].flatMap((id) => {
        const window = object(rate[id]);

        if (!percent(window.used_percent)) {
            return [];
        }

        const seconds = window.limit_window_seconds;
        const label =
            seconds === 604800
                ? "Weekly"
                : seconds === 18000
                  ? "Five hours"
                  : typeof seconds === "number" && seconds > 0
                    ? `${seconds / 3600} hours`
                    : id === "primary_window"
                      ? "Primary window"
                      : "Secondary window";

        return [{ id, label, usedPercent: window.used_percent, resetAt: iso(window.reset_at) }];
    });
}

class UsageFailure extends Error {}
const FIVE_MINUTES = 300_000;
const MAX_STALE = 3_600_000;

type Models = Pick<
    ModelRuntime,
    "getProviders" | "getModels" | "getProviderAuthStatus" | "getAuth"
>;

export class SubscriptionUsage {
    readonly #models: () => Models;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #cache = new Map<string, SubscriptionAccount>();
    readonly #pending = new Map<string, Promise<SubscriptionAccount>>();
    #generation = 0;
    constructor(models: () => Models, fetcher = fetch, now = Date.now) {
        this.#models = models;
        this.#fetch = fetcher;
        this.#now = now;
    }
    clear(): void {
        this.#generation++;
        this.#cache.clear();
        this.#pending.clear();
    }
    async summary(): Promise<{ accounts: SubscriptionAccount[] }> {
        const models = this.#models();
        const providers = models
            .getProviders()
            .filter(
                (provider) =>
                    models.getProviderAuthStatus(provider.id).configured &&
                    this.#kind(provider.id) !== undefined,
            );

        return {
            accounts: await Promise.all(
                providers.map((provider) => this.#account(provider.id, provider.name)),
            ),
        };
    }
    #kind(id: string): "claude" | "codex" | undefined {
        const uses = (api: string, origin: string) =>
            this.#models()
                .getModels(id)
                .some((model) => {
                    if (model.api !== api) {
                        return false;
                    }

                    try {
                        return new URL(model.baseUrl).origin === origin;
                    } catch {
                        return false;
                    }
                });

        if (/codex/.test(id) || uses("openai-codex-responses", "https://chatgpt.com")) {
            return "codex";
        }

        if (
            /^(anthropic|claude)(-|$)/.test(id) ||
            uses("anthropic-messages", "https://api.anthropic.com")
        ) {
            return "claude";
        }

        return undefined;
    }
    #account(id: string, name: string): Promise<SubscriptionAccount> {
        const cached = this.#cache.get(id);

        if (cached && Date.parse(cached.nextCheckAt) > this.#now()) {
            return Promise.resolve(cached);
        }

        const pending = this.#pending.get(id);

        if (pending) {
            return pending;
        }

        const generation = this.#generation;
        const promise = this.#read(id, name, cached)
            .then((value) => {
                if (generation === this.#generation) {
                    this.#cache.set(id, value);
                }

                return value;
            })
            .finally(() => {
                if (this.#pending.get(id) === promise) {
                    this.#pending.delete(id);
                }
            });

        this.#pending.set(id, promise);

        return promise;
    }
    async #read(
        id: string,
        name: string,
        previous?: SubscriptionAccount,
    ): Promise<SubscriptionAccount> {
        const base: SubscriptionAccount = {
            id,
            name,
            state: "unavailable",
            windows: [],
            checkedAt: null,
            nextCheckAt: new Date(this.#now() + FIVE_MINUTES).toISOString(),
            stale: false,
        };

        try {
            // Uses the same serialized refresh as model requests; never refresh a separate copy of a token.
            const resolved = await this.#models().getAuth(id);
            const token = resolved?.auth.apiKey;

            if (!token) {
                return {
                    ...base,
                    state: "signed_out",
                    message: "No saved subscription login is available.",
                };
            }

            const headers: Record<string, string> = {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
            };
            const kind = this.#kind(id);
            let url: string;

            if (kind === "claude") {
                if (!token.startsWith("sk-ant-oat")) {
                    return {
                        ...base,
                        state: "unsupported",
                        message:
                            "API key account. Subscription limits are available with Claude OAuth.",
                    };
                }

                url = "https://api.anthropic.com/api/oauth/usage";
                headers["anthropic-beta"] = "oauth-2025-04-20";
            } else {
                let accountId: unknown;

                try {
                    accountId = object(
                        JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()),
                    )["https://api.openai.com/auth"];
                } catch {
                    /* Not a subscription token. */
                }

                const selected = object(accountId).chatgpt_account_id;

                if (typeof selected !== "string" || !selected) {
                    return {
                        ...base,
                        state: "unsupported",
                        message: "No ChatGPT subscription account was reported by this login.",
                    };
                }

                url = "https://chatgpt.com/backend-api/wham/usage";
                headers["ChatGPT-Account-Id"] = selected;
            }

            // Fixed destinations and no redirects: credentials never follow a provider redirect.
            const response = await this.#fetch(url, {
                headers,
                signal: AbortSignal.timeout(10_000),
                redirect: "error",
            });

            if (!response.ok) {
                const retry = response.headers.get("retry-after");
                const retryAt =
                    retry && /^\d+$/.test(retry)
                        ? this.#now() + Number(retry) * 1000
                        : retry
                          ? Date.parse(retry)
                          : NaN;

                if (Number.isFinite(retryAt) && retryAt > this.#now() && retryAt < 8.64e15) {
                    base.nextCheckAt = new Date(
                        Math.max(retryAt, this.#now() + FIVE_MINUTES),
                    ).toISOString();
                }

                await response.body?.cancel();

                throw new UsageFailure(
                    response.status === 429
                        ? "Usage checks are rate limited. Pocket will retry after the cooldown."
                        : response.status === 401 || response.status === 403
                          ? "The provider rejected the usage check. Your Pocket sign-in has not changed."
                          : "The provider's usage service is temporarily unavailable.",
                );
            }

            const payload: unknown = await response.json();
            const windows = kind === "claude" ? claudeWindows(payload) : codexWindows(payload);

            if (!windows.length) {
                throw new UsageFailure(
                    "The provider did not report subscription limits for this account.",
                );
            }

            return {
                ...base,
                state: "ready",
                windows,
                checkedAt: new Date(this.#now()).toISOString(),
            };
        } catch (error) {
            const known =
                error instanceof UsageFailure
                    ? error.message
                    : "Could not check subscription usage. Your saved login has not changed.";
            const recent =
                previous?.checkedAt && this.#now() - Date.parse(previous.checkedAt) < MAX_STALE;

            return {
                ...base,
                ...(recent
                    ? { windows: previous.windows, checkedAt: previous.checkedAt, stale: true }
                    : {}),
                message: known,
            };
        }
    }
}

export function checkSubscriptionUsage() {
    if (
        claudeWindows({ five_hour: { utilization: 25, resets_at: null } })[0]?.usedPercent !== 25 ||
        codexWindows({
            rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } },
        })[0]?.label !== "Weekly"
    ) {
        throw new Error("Subscription usage validation failed");
    }

    return { feature: "subscription-usage", version: 1 };
}
