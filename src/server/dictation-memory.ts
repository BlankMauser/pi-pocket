/** What dictation cleanup has learned from the owner's corrections, and what it has cost. Small private JSON files. */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_CORRECTIONS = 300;
const MAX_TERMS = 300;
const MAX_TEXT = 60;
const TERM_THRESHOLD = 3;
const KEEP_DAYS = 45;

type Correction = { wanted: string; count: number; at: number };
type Learned = {
    version: 1;
    corrections: Record<string, Correction>;
    terms: Record<string, { count: number; at: number }>;
};
type Day = {
    n: number;
    input: number;
    output: number;
    cacheRead: number;
    cost: number;
    ms: number;
};
type Usage = { version: 1; days: Record<string, Day> };

/** One short line of plain text: no control characters or markup that could pass as an instruction. */
export function tidy(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const text = value
        .replace(/[\u0000-\u001f\u007f`<>{}]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return text === "" || text.length > MAX_TEXT ? undefined : text;
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

export class DictationMemory {
    readonly #dir: string;
    #learned: Learned | undefined;
    #usage: Usage | undefined;
    #writing: Promise<unknown> = Promise.resolve();

    constructor(directory: string) {
        this.#dir = directory;
    }

    async #load<T>(name: string, empty: T): Promise<T> {
        try {
            const value = JSON.parse(await readFile(join(this.#dir, name), "utf8")) as T & {
                version?: number;
            };

            return value.version === 1 ? value : empty;
        } catch {
            return empty;
        }
    }

    #save(name: string, value: unknown): Promise<void> {
        // One write at a time, each replacing the file whole, so a crash never leaves half a file.
        const write = this.#writing.then(async () => {
            const path = join(this.#dir, name);

            await mkdir(this.#dir, { recursive: true, mode: 0o700 });
            await writeFile(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
            await rename(`${path}.new`, path);
        });

        this.#writing = write.catch(() => undefined);

        return write;
    }

    async #learnedData(): Promise<Learned> {
        return (this.#learned ??= await this.#load<Learned>("dictation-learned.json", {
            version: 1,
            corrections: {},
            terms: {},
        }));
    }

    /** Remember what was mis-heard and the owner's fix, and count terms they keep using. Returns what changed. */
    async learn(corrections: unknown, terms: unknown, now = Date.now()): Promise<number> {
        const data = await this.#learnedData();
        let changed = 0;

        for (const item of (Array.isArray(corrections) ? corrections : []).slice(0, 20)) {
            const heard = tidy(item?.heard)?.toLowerCase();
            const wanted = tidy(item?.wanted);

            if (heard === undefined || wanted === undefined || heard === wanted) {
                continue;
            }

            const known = data.corrections[heard];

            data.corrections[heard] = {
                wanted,
                count: known?.wanted === wanted ? known.count + 1 : 1,
                at: now,
            };
            changed++;
        }

        for (const item of (Array.isArray(terms) ? terms : []).slice(0, 30)) {
            const term = tidy(item);

            if (term === undefined) {
                continue;
            }

            data.terms[term] = { count: (data.terms[term]?.count ?? 0) + 1, at: now };
            changed++;
        }

        if (changed === 0) {
            return 0;
        }

        for (const [key, limit] of [
            ["corrections", MAX_CORRECTIONS],
            ["terms", MAX_TERMS],
        ] as const) {
            const table = data[key] as Record<string, { count: number; at: number }>;
            const entries = Object.entries(table);

            if (entries.length > limit) {
                entries.sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at);
                data[key] = Object.fromEntries(entries.slice(0, limit)) as never;
            }
        }

        await this.#save("dictation-learned.json", data);

        return changed;
    }

    async remove(kind: unknown, key: unknown): Promise<boolean> {
        const data = await this.#learnedData();
        const table =
            kind === "correction" ? data.corrections : kind === "term" ? data.terms : undefined;

        if (table === undefined || typeof key !== "string" || !(key in table)) {
            return false;
        }

        delete table[key];
        await this.#save("dictation-learned.json", data);

        return true;
    }

    /** For the editor: everything learned, most used first. */
    async list() {
        const data = await this.#learnedData();
        const byUse = <T extends { count: number; at: number }>(a: T, b: T) =>
            b.count - a.count || b.at - a.at;

        return {
            corrections: Object.entries(data.corrections)
                .map(([heard, value]) => ({ heard, ...value }))
                .sort(byUse),
            terms: Object.entries(data.terms)
                .map(([term, value]) => ({ term, ...value }))
                .sort(byUse),
        };
    }

    /** The reference lines for the model: fixes the owner made, then terms they use a lot. */
    async promptText(): Promise<string> {
        const { corrections, terms } = await this.list();
        const fixes = corrections.slice(0, 100).map((c) => `- ${c.heard} → ${c.wanted}`);
        const common = terms
            .filter((t) => t.count >= TERM_THRESHOLD)
            .slice(0, 100)
            .map((t) => t.term);

        return [
            fixes.length === 0
                ? ""
                : `Spellings the owner corrected (heard → correct):\n${fixes.join("\n")}`,
            common.length === 0 ? "" : `Terms the owner uses often: ${common.join(", ")}`,
        ]
            .filter(Boolean)
            .join("\n\n");
    }

    async recordUsage(
        usage: { input: number; output: number; cacheRead: number; cost: { total: number } },
        ms: number,
        now = Date.now(),
    ): Promise<void> {
        const data = (this.#usage ??= await this.#load<Usage>("dictation-usage.json", {
            version: 1,
            days: {},
        }));
        const day = (data.days[dayOf(now)] ??= {
            n: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cost: 0,
            ms: 0,
        });

        day.n++;
        day.input += usage.input;
        day.output += usage.output;
        day.cacheRead += usage.cacheRead;
        day.cost += usage.cost.total;
        day.ms += ms;

        for (const key of Object.keys(data.days)) {
            if (key < dayOf(now - KEEP_DAYS * 86_400_000)) {
                delete data.days[key];
            }
        }

        await this.#save("dictation-usage.json", data);
    }

    async stats(now = Date.now()) {
        const data = (this.#usage ??= await this.#load<Usage>("dictation-usage.json", {
            version: 1,
            days: {},
        }));

        const sum = (since: string) => {
            const total = { n: 0, input: 0, output: 0, cacheRead: 0, cost: 0, ms: 0 };

            for (const [key, day] of Object.entries(data.days)) {
                if (key >= since) {
                    for (const field of Object.keys(total) as (keyof typeof total)[]) {
                        total[field] += day[field];
                    }
                }
            }

            return {
                cleanups: total.n,
                cost: total.cost,
                inputTokens: total.input,
                outputTokens: total.output,
                cachedInputTokens: total.cacheRead,
                averageSeconds: total.n === 0 ? 0 : total.ms / total.n / 1000,
            };
        };

        return {
            today: sum(dayOf(now)),
            last7Days: sum(dayOf(now - 6 * 86_400_000)),
            last30Days: sum(dayOf(now - 29 * 86_400_000)),
        };
    }
}
