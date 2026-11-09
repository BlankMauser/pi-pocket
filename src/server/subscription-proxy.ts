/** Supplement native usage with current scoped Claude limits, Kimi and OpenCode Go without restarting Pocket. */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SubscriptionUsage, type SubscriptionAccount } from "./subscription-usage.ts";

type Provider = { id: string; name: string };
const BASE_PROVIDERS: Provider[] = [
    { id: "opencode-go", name: "OpenCode Go" },
    { id: "kimi-coding", name: "Kimi Code" },
];

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};

/** Keep the native shared limits when a supplemental Fable check fails. Unknown never becomes zero usage. */
export function addFableUsage(
    native: SubscriptionAccount,
    extra: SubscriptionAccount,
): SubscriptionAccount {
    const fable = extra.windows.filter((window) => window.id === "seven_day_fable");
    const nativeFable = native.windows.some((window) => window.id === "seven_day_fable");

    if (nativeFable && (extra.state !== "ready" || fable.length === 0)) {
        return native;
    }

    const result: SubscriptionAccount = {
        ...native,
        windows:
            fable.length === 0
                ? native.windows
                : [...native.windows.filter((window) => window.id !== "seven_day_fable"), ...fable],
    };

    if (fable.length === 0) {
        result.fableMessage =
            extra.state === "ready"
                ? "Claude did not report a Fable-specific allowance for this account."
                : "Fable usage could not be checked. The shared limits below are still available.";
    } else if (extra.stale) {
        result.stale = true;
        result.fableMessage = "Fable usage is last known; its latest check failed.";
        result.checkedAt = extra.checkedAt;
    }

    if (Date.parse(extra.nextCheckAt) > Date.parse(result.nextCheckAt)) {
        result.nextCheckAt = extra.nextCheckAt;
    }

    return result;
}

const nativeFable = (account: SubscriptionAccount) =>
    account.windows.some((window) => window.id === "seven_day_fable");
const claudeAccount = (account: SubscriptionAccount) =>
    account.windows.some((window) => window.id === "seven_day") ||
    /claude|anthropic/.test(account.id);
const unavailableFable = (account: SubscriptionAccount): SubscriptionAccount =>
    claudeAccount(account) && !nativeFable(account) && account.state !== "unsupported"
        ? {
              ...account,
              fableMessage:
                  "Fable usage is temporarily unavailable. Shared limits are still shown.",
          }
        : account;

export function createUsageHandler({
    upstream,
    authFile,
    modelsFile = join(dirname(authFile), "models.json"),
    fetcher = fetch,
    now = Date.now,
}: {
    upstream: string;
    authFile: string;
    modelsFile?: string;
    fetcher?: typeof fetch;
    now?: () => number;
}) {
    let claudeProviders: Provider[] = [];
    let identity = "";
    const models = {
        getProviders: () => [...BASE_PROVIDERS, ...claudeProviders],
        getModels: (id: string) =>
            claudeProviders.some((p) => p.id === id)
                ? [{ api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }]
                : [],
        getProviderAuthStatus: () => ({ configured: true }),
        async getAuth(id: string) {
            // Read only the current saved access token: token renewal stays in the native runtime.
            const credential = object(JSON.parse(await readFile(authFile, "utf8"))[id]);
            const key =
                credential.type === "api_key"
                    ? credential.key
                    : claudeProviders.some((p) => p.id === id) && credential.type === "oauth"
                      ? credential.access
                      : undefined;

            return typeof key === "string" && key && !key.startsWith("!")
                ? { auth: { apiKey: key } }
                : undefined;
        },
    } as unknown as Pick<
        ModelRuntime,
        "getProviders" | "getModels" | "getProviderAuthStatus" | "getAuth"
    >;
    const usage = new SubscriptionUsage(() => models, fetcher, now);

    return async (req: IncomingMessage, res: ServerResponse) => {
        const send = (status: number, data: unknown) => {
            res.writeHead(status, {
                "content-type": "application/json",
                "cache-control": "no-store",
            });
            res.end(JSON.stringify(data));
        };

        if (
            req.method !== "GET" ||
            new URL(req.url ?? "/", "http://localhost").pathname !== "/api/subscription-usage"
        ) {
            return send(404, { error: "Unknown endpoint" });
        }

        try {
            // Authorize through Pocket before reading any saved credentials, on every request.
            const headers: Record<string, string> = { Accept: "application/json" };

            for (const name of ["authorization", "cookie"] as const) {
                if (typeof req.headers[name] === "string") {
                    headers[name] = req.headers[name];
                }
            }

            const response = await fetcher(`${upstream}/api/subscription-usage`, {
                headers,
                redirect: "error",
                signal: AbortSignal.timeout(30_000),
            });
            const data = (await response.json()) as { accounts?: SubscriptionAccount[] };

            if (response.status !== 200) {
                return send(response.status, data);
            }

            if (!Array.isArray(data.accounts)) {
                throw new Error("Invalid upstream response");
            }

            let credentialsText: string;
            let credentials: Value;

            try {
                credentialsText = await readFile(authFile, "utf8");
                credentials = object(JSON.parse(credentialsText));
            } catch {
                return send(200, { ...data, accounts: data.accounts.map(unavailableFable) });
            }

            const nextIdentity = createHash("sha256").update(credentialsText).digest("hex");

            if (identity !== nextIdentity) {
                usage.clear();
                identity = nextIdentity;
            }

            let config: Value = {};
            let configUnavailable = false;

            try {
                config = object(object(JSON.parse(await readFile(modelsFile, "utf8"))).providers);
            } catch {
                configUnavailable = true;
            }

            claudeProviders = data.accounts.flatMap((account) => {
                if (nativeFable(account)) {
                    return [];
                }

                const provider = object(config[account.id]);
                const credential = object(credentials[account.id]);
                let native = false;

                try {
                    native =
                        provider.api === "anthropic-messages" &&
                        typeof provider.baseUrl === "string" &&
                        new URL(provider.baseUrl).origin === "https://api.anthropic.com";
                } catch {
                    configUnavailable = true;
                }

                return native && credential.type === "oauth"
                    ? [{ id: account.id, name: account.name }]
                    : [];
            });
            const extra = await usage.summary();
            const extras = new Map(extra.accounts.map((account) => [account.id, account]));
            const baseIds = new Set(BASE_PROVIDERS.map((provider) => provider.id));
            const claudeIds = new Set(claudeProviders.map((provider) => provider.id));
            const accounts = data.accounts
                .filter((account) => !baseIds.has(account.id))
                .map((account) => {
                    const supplement = extras.get(account.id);

                    return supplement && claudeIds.has(account.id)
                        ? addFableUsage(account, supplement)
                        : configUnavailable
                          ? unavailableFable(account)
                          : account;
                });

            return send(200, {
                ...data,
                accounts: [
                    ...accounts,
                    ...extra.accounts.filter((account) => baseIds.has(account.id)),
                ],
            });
        } catch {
            return send(502, { error: "Could not check subscription usage. Retry shortly." });
        }
    };
}

export function startUsageProxy() {
    const handler = createUsageHandler({
        upstream: "http://127.0.0.1:8796",
        authFile: "/run/matchamill-pocket/home/.pi/agent/auth.json",
    });

    return http
        .createServer(handler)
        .listen(
            Number(process.env.POCKET_USAGE_PORT ?? 8795),
            process.env.POCKET_USAGE_HOST ?? "127.0.0.1",
        );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    startUsageProxy();
}
