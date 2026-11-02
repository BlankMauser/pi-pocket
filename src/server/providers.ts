/**
 * Model providers: which ones Pi knows, whether each is signed in, and sign-ins run from the app. A sign-in asks its
 * questions (an API key, a code, a choice) through the tabs of the person who started it. Pi Pocket shares Pi's own
 * sign-ins (`~/.pi/agent/auth.json`).
 */
import { randomUUID } from "node:crypto";
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { modelList } from "./models.ts";
import { SubscriptionUsage } from "./subscription-usage.ts";

interface AuthFlow {
    id: string;
    userId: string;
    prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>;
    abort: AbortController;
}

export class Providers {
    readonly #app: PocketApp;
    readonly #usage: SubscriptionUsage;
    readonly #flows = new Map<string, AuthFlow>();
    #watcher: FSWatcher | undefined;
    /** The one timer that waits out a burst of saves; `refresh()` re-arms it without making another. */
    #settle: NodeJS.Timeout | undefined;
    #reloading = false;
    #again = false;

    constructor(app: PocketApp) {
        this.#app = app;
        this.#usage = new SubscriptionUsage(() => this.#app.models);
    }

    /**
     * Pick up edits to Pi's `models.json` and `auth.json` without a restart. The operating system tells us when the
     * folder changes (inotify and its kin), so nothing runs, polls, or allocates while the files are quiet. A burst
     * of saves, as an editor makes, is one reload a moment after the last. Nothing is fetched: it re-reads the files.
     */
    watchConfig(): void {
        const directory = getAgentDir();

        try {
            // The folder, not the files: editors replace a file by renaming another over it, which ends a file watch.
            this.#watcher = watch(directory, { persistent: false }, (_event, name) => {
                if (name === "models.json" || name === "auth.json") {
                    this.#schedule();
                }
            });
            this.#watcher.on("error", (error) => {
                this.#app.log(`Model files are no longer watched: ${describe(error)}`);
                this.#watcher?.close();
                this.#watcher = undefined;
            });
        } catch (error) {
            this.#app.log(
                `Model files are not watched (restart to pick up changes): ${describe(error)}`,
            );
        }
    }

    #schedule(): void {
        if (this.#settle === undefined) {
            this.#settle = setTimeout(this.#reload, 400);
        } else {
            this.#settle.refresh();
        }
    }

    #reload = (): void => {
        this.#settle = undefined;

        if (this.#reloading) {
            this.#again = true;

            return;
        }

        this.#reloading = true;
        void this.#refresh().finally(() => {
            this.#reloading = false;

            if (this.#again) {
                this.#again = false;
                this.#schedule();
            }
        });
    };

    async #refresh(): Promise<void> {
        try {
            // A half-written models.json would read as "no models" and empty the picker: wait for the next save.
            JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.#app.log(
                    `models.json not reloaded, it does not parse yet: ${describe(error)}`,
                );

                return;
            }
        }

        try {
            this.#usage.clear();
            await this.#app.models.refresh({ allowNetwork: false });
            await this.#app.models.getAvailable().catch(() => []);

            const problem = this.#app.models.getError();

            if (problem !== undefined) {
                this.#app.notice("warning", `models.json: ${problem}`);
            }

            this.#sendModels();
        } catch (error) {
            this.#app.log(`Model reload failed: ${describe(error)}`);
        }
    }

    subscriptionUsage() {
        return this.#usage.summary();
    }

    list() {
        const models = this.#app.models;

        return models.getProviders().map((provider) => {
            const status = models.getProviderAuthStatus(provider.id);
            const auth = (
                provider as {
                    auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } };
                }
            ).auth;

            return {
                id: provider.id,
                name: provider.name,
                configured: status.configured,
                source: status.source ?? null,
                label: status.label ?? null,
                apiKey: auth?.apiKey !== undefined,
                oauth:
                    auth?.oauth === undefined
                        ? null
                        : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
                models: models.getModels(provider.id).length,
            };
        });
    }

    startLogin(user: User, providerId: string, type: "api_key" | "oauth"): string {
        const app = this.#app;
        const flow: AuthFlow = {
            id: randomUUID(),
            userId: user.id,
            prompts: new Map(),
            abort: new AbortController(),
        };

        this.#flows.set(flow.id, flow);

        const send = (data: Record<string, unknown>) => {
            for (const client of app.clients) {
                if (client.user.id === user.id) {
                    client.send("auth", { flowId: flow.id, providerId, ...data });
                }
            }
        };

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolvePrompt, rejectPrompt) => {
                    const promptId = randomUUID();

                    flow.prompts.set(promptId, { resolve: resolvePrompt, reject: rejectPrompt });
                    const { signal, ...shown } = prompt;

                    signal?.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        send({ step: "prompt-closed", promptId });
                        rejectPrompt(new Error("cancelled"));
                    });
                    send({ step: "prompt", promptId, prompt: shown });
                }),
            notify: (event: unknown) => send({ step: "event", event }),
        };

        void app.models
            // Sign-ins that identify the installation (ChatGPT) get the ID Pi keeps for it, the same as Pi's own login.
            .login(providerId, type, interaction, {
                getDeviceId: () => app.settings.getOrCreateDeviceId(),
            })
            .then(
                async () => {
                    this.#usage.clear();
                    await app.models.getAvailable().catch(() => []);
                    send({ step: "done", ok: true });
                    this.#sendModels();
                },
                (error: unknown) => send({ step: "done", ok: false, error: describe(error) }),
            )
            .finally(() => this.#flows.delete(flow.id));

        return flow.id;
    }

    answerLogin(user: User, flowId: string, promptId: string, value: string | undefined): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            throw new HttpError(404, "No such login");
        }

        const prompt = flow.prompts.get(promptId);

        if (prompt === undefined) {
            throw new HttpError(404, "No such prompt");
        }

        flow.prompts.delete(promptId);

        if (value === undefined) {
            prompt.reject(new Error("cancelled"));
            flow.abort.abort();
        } else {
            prompt.resolve(value);
        }
    }

    /** Stop a sign-in its person gave up on, whether or not it is asking something. */
    cancelLogin(user: User, flowId: string): void {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== user.id) {
            return;
        }

        for (const prompt of flow.prompts.values()) {
            prompt.reject(new Error("cancelled"));
        }

        flow.prompts.clear();
        flow.abort.abort();
    }

    async logout(providerId: string): Promise<void> {
        await this.#app.models.logout(providerId);
        this.#usage.clear();
        await this.#app.models.getAvailable().catch(() => []);
        this.#sendModels();
    }

    /** Every tab gets the models available now. */
    #sendModels(): void {
        const models = modelList(this.#app.models);

        for (const client of this.#app.clients) {
            client.send("models", models);
        }
    }

    close(): void {
        clearTimeout(this.#settle);
        this.#watcher?.close();

        for (const flow of this.#flows.values()) {
            flow.abort.abort();
        }
    }
}
