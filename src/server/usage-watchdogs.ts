/** Owner-only status and stop operations for the host's usage watchdog timers. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { HttpError } from "./errors.ts";

const exec = promisify(execFile);
const HELPER = "/opt/matchamill/pi-pocket/usage-watchdog/control.py";

export type UsageWatchdog = {
    session: number;
    active: boolean;
    enabled: boolean;
    stopped: boolean;
    switchingEnabled: boolean;
    nextCheckAt: string | null;
    lastCheckedAt: string | null;
    currentProvider: string | null;
    modelId: string | null;
    lastAction: string | null;
    switched: boolean;
    stoppedAt: string | null;
};
export type WatchdogStatus = { available: boolean; watchdogs: UsageWatchdog[]; message?: string };

type Runner = (args: string[]) => Promise<unknown>;

async function run(args: string[]): Promise<unknown> {
    const { stdout } = await exec(
        "/usr/bin/sudo",
        ["-n", "/usr/bin/python3", "-I", HELPER, ...args],
        {
            timeout: 20_000,
            maxBuffer: 1_048_576,
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        },
    );

    return JSON.parse(stdout);
}

/** The bridge can only inspect watchdogs or stop one numeric conversation ID. */
export class UsageWatchdogs {
    readonly #run: Runner;
    readonly #available: () => boolean;
    #pending: Promise<WatchdogStatus> | undefined;

    constructor(
        runner: Runner = run,
        available = () => process.platform === "linux" && existsSync(HELPER),
    ) {
        this.#run = runner;
        this.#available = available;
    }

    async status(): Promise<WatchdogStatus> {
        if (!this.#available()) {
            return {
                available: false,
                watchdogs: [],
                message: "Usage watchdog controls are not installed on this host.",
            };
        }

        if (this.#pending !== undefined) {
            return this.#pending;
        }

        const pending = this.#read();

        this.#pending = pending;

        try {
            return await pending;
        } finally {
            if (this.#pending === pending) {
                this.#pending = undefined;
            }
        }
    }

    async #read(): Promise<WatchdogStatus> {
        try {
            const result = (await this.#run(["status"])) as WatchdogStatus;

            if (result?.available !== true || !Array.isArray(result.watchdogs)) {
                throw new Error("Invalid watchdog status");
            }

            return result;
        } catch {
            throw new HttpError(503, "Could not read usage watchdogs. Their status is unknown.");
        }
    }

    async stop(session: number): Promise<{ session: number; stopped: true }> {
        if (!Number.isSafeInteger(session) || session <= 0) {
            throw new HttpError(400, "session must be a positive conversation ID");
        }

        if (!this.#available()) {
            throw new HttpError(503, "Usage watchdog controls are not installed on this host.");
        }

        try {
            const result = (await this.#run(["stop", String(session)])) as {
                session?: number;
                stopped?: boolean;
            };

            if (result?.stopped !== true || result.session !== session) {
                throw new Error("Stop was not verified");
            }

            // A read started before Stop may still hold the old active state.
            this.#pending = undefined;

            return { session, stopped: true };
        } catch {
            throw new HttpError(503, "Could not stop the usage watchdog. Its status is unknown.");
        }
    }
}
