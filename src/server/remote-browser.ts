/** The browser follows the conversation's execution machine; its saved address stays on the VM. */
import { Browsers, type BrowsersOptions, type OpenOptions } from "./browser.ts";
import { BrowserError } from "./browser/cdp.ts";
import type { BrowserPage, BrowserState, Saved } from "./browser/page.ts";
import { VIEWPORTS } from "./browser/viewport.ts";
import type { Workers } from "./workers.ts";
import { machinePath } from "./workers.ts";

type Reply<T> = { result: T; state: BrowserState; saved?: Saved };

export class RoutedBrowsers extends Browsers {
    readonly #options: BrowsersOptions;
    readonly #workers: Workers;
    readonly #cwd: (id: number) => string;
    readonly #states = new Map<number, BrowserState>();
    readonly #targets = new Map<number, string>();
    readonly #listeners = new Set<(id: number, state: BrowserState) => void>();
    readonly #refreshing = new Set<number>();
    readonly #poll: NodeJS.Timeout;

    constructor(options: BrowsersOptions, workers: Workers, cwd: (id: number) => string) {
        super(options);
        this.#options = options;
        this.#workers = workers;
        this.#cwd = cwd;
        this.#poll = setInterval(() => {
            for (const [id, state] of this.#states) {
                if (state.open && !this.#refreshing.has(id)) {
                    this.#refreshing.add(id);
                    void this.remote(id, "state")
                        .catch(() => undefined)
                        .finally(() => this.#refreshing.delete(id));
                }
            }
        }, 2000);
        this.#poll.unref();
    }

    override subscribe(listener: (id: number, state: BrowserState) => void): () => void {
        this.#listeners.add(listener);
        const off = super.subscribe(listener);

        return () => {
            this.#listeners.delete(listener);
            off();
        };
    }

    #changed(id: number, state: BrowserState): void {
        const old = this.#states.get(id);

        this.#states.set(id, state);

        if (JSON.stringify(old) !== JSON.stringify(state)) {
            for (const listener of this.#listeners) {
                listener(id, state);
            }
        }
    }

    override state(id: number): BrowserState {
        if (machinePath(this.#cwd(id)) === undefined) {
            return super.state(id);
        }

        return (
            this.#states.get(id) ?? {
                available: true,
                open: false,
                url: "",
                title: "",
                loading: false,
                viewport: { ...VIEWPORTS.desktop },
                preset: "desktop",
                canGoBack: false,
                canGoForward: false,
                errors: 0,
                logs: 0,
            }
        );
    }

    async remote<T>(id: number, op: string, args: Record<string, unknown> = {}): Promise<T> {
        const cwd = this.#cwd(id);
        const previous = this.#targets.get(id);

        if (previous !== undefined && previous !== cwd) {
            await this.#workers.rpc(previous, "browser.close", { id }).catch(() => undefined);
            this.#states.delete(id);
        }

        this.#targets.set(id, cwd);
        const saved = await this.#options.load?.(id);

        try {
            const reply = await this.#workers.rpc<Reply<T>>(cwd, `browser.${op}`, {
                ...args,
                id,
                saved,
            });

            this.#changed(id, reply.state);

            if (reply.saved !== undefined) {
                this.#options.save?.(id, reply.saved);
            }

            return reply.result;
        } catch (error) {
            this.#changed(id, {
                ...this.state(id),
                open: false,
                loading: false,
                problem: String(error instanceof Error ? error.message : error),
            });

            throw error;
        }
    }

    override async open(id: number, options: OpenOptions = {}): Promise<BrowserPage> {
        if (
            process.env.PI_POCKET_WORKERS_ONLY === "1" ||
            machinePath(this.#cwd(id)) !== undefined
        ) {
            throw new BrowserError(
                "Use the browser connected to this session's execution machine.",
            );
        }

        return super.open(id, options);
    }

    override async close(id: number): Promise<void> {
        if (machinePath(this.#cwd(id)) === undefined) {
            return super.close(id);
        }

        await this.remote(id, "close");
    }

    override async closeAll(options: { final?: boolean } = {}): Promise<void> {
        if (options.final) {
            clearInterval(this.#poll);
        }

        const ids = [...this.#states.keys()];

        await Promise.all(ids.map((id) => this.close(id).catch(() => undefined)));
        this.#states.clear();
        this.#targets.clear();
        await super.closeAll(options);
    }
}
