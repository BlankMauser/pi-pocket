/** Machine-bound folders stay bound to that machine, including while it is offline. */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Connection as WorkerConnection } from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { HttpError } from "./errors.ts";
import type { Head } from "./branches.ts";
import type { PromptTemplate, SkillCommand } from "./prompts.ts";

const native = (
    globalThis as typeof globalThis & {
        __piPocketRuntime?: { modules: Record<string, unknown> };
    }
).__piPocketRuntime;
const { Connection, RemoteExecutionEnv } = (native?.modules["@earendil-works/pi-env"] ??
    (await import("@earendil-works/pi-env"))) as typeof import("@earendil-works/pi-env");

export type MachinePath = { machineId: string; path: string };
export type WorkerInfo = {
    id: string;
    name: string;
    online: boolean;
    home?: string;
    cwd?: string;
    platform?: string;
};
export type WorkerResources = {
    context?: string;
    skills?: string;
    commands: SkillCommand[];
    templates: PromptTemplate[];
    platform: string;
    home: string;
};

export function machinePath(value: string): MachinePath | undefined {
    if (!value.startsWith("mm://")) {
        return undefined;
    }

    const match = /^mm:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})(\/[^\0]*)$/.exec(value);

    if (match === null) {
        throw new HttpError(400, "Invalid machine folder.");
    }

    const path = posix.normalize(match[2]!.replaceAll("\\", "/"));

    // Drive letters are encoded beneath the URI slash, but the daemon needs a native Windows path.
    return {
        machineId: match[1]!,
        path: /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll("/", "\\") : path,
    };
}

export function machineFolder(machineId: string, path: string): string {
    path = path.replaceAll("\\", "/");
    const value = `mm://${machineId}${path.startsWith("/") ? path : `/${path}`}`;
    const parsed = machinePath(value)!;
    const normalized = parsed.path.replaceAll("\\", "/");

    return `mm://${parsed.machineId}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

export class Workers {
    readonly #dataDir: () => string;
    readonly #connections = new Map<string, WorkerConnection>();
    readonly #metadata = new Map<string, { at: number; inRepository: boolean; head?: Head }>();
    readonly #refreshing = new Set<string>();
    readonly #resources = new Map<string, { at: number; value: WorkerResources }>();
    constructor(dataDir: () => string) {
        this.#dataDir = dataDir;
    }

    async #request<T>(route: string, body?: unknown): Promise<T> {
        let response: Response;

        try {
            const token = readFileSync(
                join(this.#dataDir(), "gateway", "control-token"),
                "utf8",
            ).trim();

            response = await fetch(
                `${process.env.PI_POCKET_WORKER_GATEWAY ?? "http://127.0.0.1:8796"}/__pocket_workers/${route}`,
                {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "content-type": "application/json",
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: AbortSignal.timeout(120_000),
                },
            );
        } catch {
            throw new HttpError(
                503,
                "The machine connection is unavailable. No work was moved to another machine.",
            );
        }

        const value = (await response.json()) as T & { error?: string };

        if (!response.ok) {
            throw new HttpError(response.status, value.error ?? "The machine is unavailable.");
        }

        return value;
    }

    async list(): Promise<WorkerInfo[]> {
        const result = await this.#request<WorkerInfo[] | { workers: WorkerInfo[] }>("list");

        return Array.isArray(result) ? result : result.workers;
    }

    rpc<T>(cwd: string, op: string, args: Record<string, unknown> = {}): Promise<T> {
        const target = machinePath(cwd);

        if (target === undefined) {
            throw new HttpError(400, "Choose a machine folder.");
        }

        return this.#request<T>("rpc", {
            machineId: target.machineId,
            op,
            args: { ...args, cwd: target.path },
        });
    }

    env(cwd: string): ExecutionEnv {
        const target = machinePath(cwd)!;
        let connection = this.#connections.get(target.machineId);

        if (connection === undefined) {
            connection = new Connection({
                command: [
                    process.env.PI_POCKET_WORKER_NODE ?? "/usr/bin/node",
                    process.env.PI_POCKET_WORKER_PIPE ??
                        join(this.#dataDir(), "workers", "pipe-client.mjs"),
                    target.machineId,
                ],
            });
            this.#connections.set(target.machineId, connection);
        }

        return new RemoteExecutionEnv({
            connection,
            id: `matchamill:${target.machineId}`,
            cwd: target.path,
        });
    }

    metadata(cwd: string): { inRepository: boolean; head?: Head } {
        const known = this.#metadata.get(cwd);

        if ((known === undefined || Date.now() - known.at > 5000) && !this.#refreshing.has(cwd)) {
            this.#refreshing.add(cwd);
            void this.refresh(cwd)
                .catch(() => undefined)
                .finally(() => this.#refreshing.delete(cwd));
        }

        return known ?? { inRepository: false };
    }

    async refresh(cwd: string): Promise<void> {
        const value = await this.rpc<{ inRepository: boolean; head?: Head }>(
            cwd,
            "workspace.metadata",
        );

        this.#metadata.set(cwd, { ...value, at: Date.now() });
    }

    cachedResources(cwd: string): WorkerResources | undefined {
        return this.#resources.get(cwd)?.value;
    }
    async resources(cwd: string): Promise<WorkerResources> {
        const known = this.#resources.get(cwd);

        if (known !== undefined && Date.now() - known.at < 30_000) {
            return known.value;
        }

        const value = await this.rpc<WorkerResources>(cwd, "workspace.resources");

        this.#resources.set(cwd, { value, at: Date.now() });

        return value;
    }
}
