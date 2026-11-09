/** Provider-reported subscription quotas. Credentials stay in the native model runtime. */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type UsageWindow = {
    id: string;
    label: string;
    usedPercent: number;
    resetAt: string | null;
    allowancePercentOfWeekly?: number;
    usedPercentOfWeekly?: number;
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
    fableMessage?: string;
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
    seven_day_fable: "Weekly · Fable",
    seven_day_opus: "Weekly · Opus",
    seven_day_sonnet: "Weekly · Sonnet",
    seven_day_oauth_apps: "Weekly · OAuth apps",
    seven_day_cowork: "Weekly · Cowork",
};

export function claudeWindows(payload: unknown): UsageWindow[] {
    const data = object(payload);
    const windows = new Map<string, UsageWindow>();

    for (const [id, label] of Object.entries(CLAUDE_WINDOWS)) {
        const window = object(data[id]);

        if (percent(window.utilization)) {
            windows.set(id, {
                id,
                label,
                usedPercent: window.utilization,
                resetAt: iso(window.resets_at),
            });
        }
    }

    // New Claude responses put scoped model limits beside the shared limits. is_active marks the
    // currently binding limit, not whether a reported Fable allowance exists.
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const shares = Array.isArray(data.weekly_scoped_shares) ? data.weekly_scoped_shares : [];

    for (const [index, value] of limits.entries()) {
        const row = object(value);
        const model = object(object(row.scope).model);
        const family = [model.id, model.display_name]
            .filter((v) => typeof v === "string")
            .join(" ");
        const scoped = row.kind === "weekly_scoped";
        const id =
            row.kind === "session"
                ? "five_hour"
                : row.kind === "weekly_all"
                  ? "seven_day"
                  : scoped && /(?:^|[-\s])fable(?:$|[-\s])/i.test(family)
                    ? "seven_day_fable"
                    : scoped && /(?:^|[-\s])opus(?:$|[-\s])/i.test(family)
                      ? "seven_day_opus"
                      : scoped && /(?:^|[-\s])sonnet(?:$|[-\s])/i.test(family)
                        ? "seven_day_sonnet"
                        : undefined;

        if (id === undefined || !percent(row.percent)) {
            continue;
        }

        const share = object(shares.find((entry) => object(entry).limit_index === index));
        const window: UsageWindow = {
            id,
            label: CLAUDE_WINDOWS[id]!,
            usedPercent: row.percent,
            resetAt: iso(row.resets_at),
        };

        if (id === "seven_day_fable") {
            if (percent(share.allowance_percent_of_weekly)) {
                window.allowancePercentOfWeekly = share.allowance_percent_of_weekly;
            }

            if (percent(share.used_percent_of_weekly)) {
                window.usedPercentOfWeekly = share.used_percent_of_weekly;
            }
        }

        windows.set(id, window);
    }

    return Object.keys(CLAUDE_WINDOWS).flatMap((id) => {
        const window = windows.get(id);

        return window === undefined ? [] : [window];
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

/** OpenCode Go reports percentages directly for its shared allowance. */
export function opencodeGoWindows(payload: unknown): UsageWindow[] {
    const usage = object(object(payload).usage);

    return Object.entries({ rolling: "Five hours", weekly: "Weekly", monthly: "Monthly" }).flatMap(
        ([id, label]) => {
            const window = object(usage[id]);

            return percent(window.percent)
                ? [{ id, label, usedPercent: window.percent, resetAt: iso(window.resetsAt) }]
                : [];
        },
    );
}

/** Monthly code usage is a breakdown of the total, never a separate allowance. */
export function kimiWindows(payload: unknown): UsageWindow[] {
    const data = object(payload);
    const usage = object(data.usages);
    const windows = Object.entries({
        limit_5h: "Five hours",
        limit_7d: "Weekly",
        limit_month_total: "Monthly",
    }).flatMap(([id, label]) => {
        const window = object(usage[id]);
        const ratio =
            typeof window.used_ratio === "string" && window.used_ratio.trim() !== ""
                ? Number(window.used_ratio)
                : window.used_ratio;

        return percent(ratio)
            ? [
                  {
                      id,
                      label,
                      usedPercent: Math.round(ratio * 10_000) / 100,
                      resetAt: iso(window.reset_time),
                  },
              ]
            : [];
    });

    if (windows.length || !Array.isArray(data.limits)) {
        return windows;
    }

    return data.limits.flatMap((entry) => {
        const row = object(entry);
        const window = object(row.window);
        const detail = object(row.detail);
        const limit = Number(detail.limit);
        const used = Number(detail.used);
        const minutes = window.timeUnit === "TIME_UNIT_MINUTE" ? window.duration : undefined;
        const label = minutes === 300 ? "Five hours" : minutes === 10080 ? "Weekly" : undefined;

        return label && Number.isFinite(limit) && limit > 0 && percent(used) && detail.used != null
            ? [
                  {
                      id: minutes === 300 ? "limit_5h" : "limit_7d",
                      label,
                      usedPercent: Math.round((used / limit) * 10_000) / 100,
                      resetAt: iso(detail.resetTime),
                  },
              ]
            : [];
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
    #kind(id: string): "claude" | "codex" | "kimi" | "opencode-go" | undefined {
        if (id === "opencode-go") {
            return "opencode-go";
        }

        if (id === "kimi-coding" || id === "kimi-code") {
            return "kimi";
        }

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
                "User-Agent": "pi-pocket/0.27.0",
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
            } else if (kind === "kimi") {
                url = "https://api.kimi.com/coding/v1/usages";
            } else if (kind === "opencode-go") {
                url = "https://opencode.ai/zen/go/v1/usage";
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
            const windows =
                kind === "claude"
                    ? claudeWindows(payload)
                    : kind === "kimi"
                      ? kimiWindows(payload)
                      : kind === "opencode-go"
                        ? opencodeGoWindows(payload)
                        : codexWindows(payload);

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
