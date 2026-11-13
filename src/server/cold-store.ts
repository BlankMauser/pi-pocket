/**
 * Cold storage for finished subagents: their entries leave `pocket.sqlite` for a cold store (a Worker, `ColdClient`),
 * and come back, row for row, before anything reads or writes that conversation again (`warm`).
 *
 * Pi Durable only ever inserts entries, and reads them as ranges, so it has no API for this: the rows are copied,
 * deleted, and restored with raw SQL on Durable's own connection (its one queue, so a transaction here and a Durable
 * commit never overlap), in small transactions so that Durable's commits do not wait long. Heavy reads use a second,
 * read-only connection, which in WAL mode blocks nobody. The state of each conversation is a row of
 * `pocket_cold_units` in the same file, written in the same transactions as the entries it describes, so a crash at any
 * point leaves either every local row, or a sealed and verified cold copy (`deleting`, `archived`).
 *
 * Each archive goes to a unit of its own (`newUnit`: the conversation and a random part), recorded in the state before
 * anything is sent; this database only ever removes units it recorded, so Pocket servers that share a cold store never
 * touch each other's. With the state `deleting` go the exact ids of the verified copy (`pocket_cold_entries`): a
 * deletion deletes those and nothing else, and a read of an entry by its id alone finds its conversation there.
 *
 * Two rows of each archived conversation stay here, as well as in the cold copy: its newest entry and its newest head
 * marker. Pi Durable keeps both per conversation in memory once read (`ConversationTails`), and would keep "none" until
 * it forgets them if it read them while the rows were away; with them here, any read of them is right, cold or warm.
 *
 * `warm` is the choke point in front of Pocket's own paths to a conversation's entries (`PocketApp.conversation`,
 * `room`, `transcripts`, a subagent's `send`). Every other path, Durable's own and extensions', passes `guard`, the
 * Storage Durable is given: a read past those two rows, a write, or a new fork of a cold conversation (or of one a fork
 * reads from) waits there for its restore, so Durable never builds and keeps a context range from part of the rows; any
 * touch stops an archive of it under way. `guard` never throws into Pi Durable (a Storage error ends the Session): a
 * restore that fails leaves the call as it would have been, and the conversation cold.
 *
 * A cold store that does not answer fails the request that wanted the conversation (`warm`), or the pass, and nothing
 * else. A conversation with a record too large to send fails alone, and passes skip it until it or the limit changes.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { describe, HttpError } from "./errors.ts";

/** One `entries` row, as the cold store keeps it. `conversation_id` is the unit's. */
export type ColdRow = { id: number; head: number | null; commit_seq: number; record: string };

/** The cold store's API (`apps/pocket-cold-store` in MatchaMill). A unit is one conversation's rows. */
export interface ColdClient {
    /** Store rows; refused (`ColdConflict`) once the unit is sealed. */
    put(unit: string, rows: readonly ColdRow[]): Promise<void>;
    /** Rows with an id above `after`, in id order, a page at a time; `next` is null after the last page. */
    page(unit: string, after: number): Promise<{ rows: ColdRow[]; next: number | null }>;
    summary(unit: string): Promise<{ rows: number; bytes: number; sealed: boolean }>;
    /** Seal the unit; refused (`ColdConflict`) when it does not hold exactly so many rows and bytes. */
    seal(unit: string, rows: number, bytes: number): Promise<void>;
    remove(unit: string): Promise<void>;
}

/** The cold store did not answer, or answered with an error: nothing can be archived or restored now. */
export class ColdUnavailable extends Error {
    /** Whether the same request may work when tried again (no answer, a 5xx, an answer cut off). */
    readonly retry: boolean;

    constructor(message: string, retry = true) {
        super(message);
        this.retry = retry;
    }
}

/** The cold store refused a request that depends on its state (a sealed unit, counts that differ). */
export class ColdConflict extends Error {}

/** What a pass or a restore found wrong with one conversation's copy; it stays as it was. */
export class ColdMismatch extends Error {}

/** A record of the conversation does not fit in one request: this conversation fails, and the pass goes on. */
export class ColdTooLarge extends Error {
    /** Its rows and newest entry when it was too large (`-1` when the cold store refused it): it is skipped until they change. */
    readonly rows: number;
    readonly last: number;

    constructor(message: string, rows = -1, last = -1) {
        super(message);
        this.rows = rows;
        this.last = last;
    }
}

const TABLE = "pocket_cold_units";
const ENTRIES = "pocket_cold_entries";
const SKIPS = "pocket_cold_skips";
/** A request body stays under this, well below the cold store's limit of about 8 MB. */
const PUT_BYTES = 6 << 20;
/** Each transaction that deletes or restores rows writes at most this many, and at most `TX_BYTES` of records. */
const TX_ROWS = 256;
const TX_BYTES = 4 << 20;
/** Rows a read takes at a time on the reader, so one read never holds the event loop long. */
const READ_ROWS = 256;
const DAY = 24 * 60 * 60 * 1000;
const REPORTER = JSON.stringify("pocket.subagent-reporter");
const LIVE_TASK = "('pending', 'running', 'waiting', 'sleeping', 'completing')";

export type ColdState = "copying" | "sealed" | "deleting" | "archived";

type Unit = {
    /** The cold store's unit with the rows, as recorded when the archive began. */
    unit: string;
    state: ColdState;
    rows: number;
    bytes: number;
    last: number;
    /** The UTF-8 bytes of the records deleted here so far: `bytes` less the two rows kept, once archived. */
    freed: number;
    requests: number;
    lastPrompt: number;
};

/** A step of one conversation's archive, for tests that stop it there as a crash would. */
export type ColdStep =
    "copying" | "uploaded" | "sealed" | "verified" | "deleting" | "deleted-batch" | "archived";

export type ColdOptions = {
    client: ColdClient;
    /** How long a subagent must have been quiet before a pass may archive it. Default 24 hours. */
    ageMs?: number;
    /** How long after `warm` let a conversation through it counts as in use (`IN_USE_MS`); tests shorten it. */
    inUseMs?: number;
    /** Rows per transaction that deletes or restores (`TX_ROWS`); tests make it small to take several. */
    txRows?: number;
    /** The largest request body to send (`PUT_BYTES`); a single record over it fails its conversation alone. */
    requestBytes?: number;
    /** Tests: called after each step; a throw there stops the archive as a crash would. */
    onStep?: (step: ColdStep, id: number) => void | Promise<void>;
};

/** What the store needs from the app: the subagent tree and what is open, each read when it is needed. */
export interface ColdHost {
    parentOf(id: ConversationId): ConversationId | undefined;
    /** Whether a tab or a peek tile has the conversation open now. */
    hasRoom(id: ConversationId): boolean;
    isBusy(id: ConversationId): boolean;
    subagents(id: ConversationId): Promise<SubagentsLike | undefined>;
    log(line: string): void;
    now(): number;
}

/** The parts of `SubagentsDoc` that say whether reports are still on their way. */
export type SubagentsLike = {
    readonly agents: Readonly<Record<string, { readonly conversationId: ConversationId }>>;
    readonly outbox?: readonly { readonly name: string }[];
    readonly sending?: { readonly reports: readonly { readonly name: string }[] };
};

/** `bytes` is measured only where it is reported (`#measure`): it reads every record, which on a big file is slow. */
export type ColdCandidate = { id: number; rows: number; bytes?: number; quietSince: number };

export type PassReport = {
    dryRun: boolean;
    ageHours: number;
    /**
     * Every conversation that may be archived now, with its rows and the UTF-8 bytes of their records. `bytes` only in
     * a dry run: a pass measures only the ones it takes (`selected`), as measuring reads every record.
     */
    eligible: { conversations: number; rows: number; bytes?: number };
    /** Why the other subagents may not, by reason. */
    skipped: Record<string, number>;
    /** The ones this pass takes (or would take): the quiet longest first, up to `limit`. */
    selected: { id: number; rows: number; bytes: number }[];
    /** `bytes` went to the cold store; `freedBytes` of records left this file (the two rows each keeps stay). */
    archived: { conversations: number; rows: number; bytes: number; freedBytes: number };
    /** Deletions a crash or a stop cut off, finished first. */
    resumed: number;
    /** Units of attempts a crash cut off before they deleted anything, removed first. */
    cleaned: number;
    failed: { id: number; error: string }[];
    /** Why the pass stopped before it took all it selected. */
    stopped?: string;
};

export type ColdStatus = {
    configured: boolean;
    running: boolean;
    archived: number;
    /** Archives cut off while their local rows were being deleted: cold until restored, finished by the next pass. */
    deleting: number;
    rows: number;
    bytes: number;
    /** The UTF-8 bytes of records deleted here; the file shrinks by about as much only after a `VACUUM`. */
    freedBytes: number;
    /** Conversations passes skip, as a record of theirs is over the request limit (`pocket_cold_skips`). */
    tooLarge: number;
    /** Without bytes: a dry run measures them. */
    eligible?: { conversations: number; rows: number };
    lastPass?: { at: number; dryRun: boolean; archived: number; bytes: number; failed: number };
    lastError?: { at: number; conversationId?: number; message: string };
};

/**
 * The cold store's settings: `PI_POCKET_COLD_STORE_URL`, and its key from the file `PI_POCKET_COLD_STORE_KEY_FILE`.
 * `PI_POCKET_COLD_STORE_KEY` works too, but it is deleted from `env` as soon as it is read, so that no command Pocket
 * runs for an agent (which get this process's environment) ever sees it. Read when the app is made, before anything
 * starts a child process.
 */
export function coldStoreFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): { client: ColdClient; ageMs: number } | undefined {
    const url = env.PI_POCKET_COLD_STORE_URL?.trim();

    if (url === undefined || url === "") {
        delete env.PI_POCKET_COLD_STORE_KEY;

        return undefined;
    }

    const file = env.PI_POCKET_COLD_STORE_KEY_FILE?.trim();
    const fromEnv = env.PI_POCKET_COLD_STORE_KEY;

    delete env.PI_POCKET_COLD_STORE_KEY;

    const key = (file !== undefined && file !== "" ? readFileSync(file, "utf8") : fromEnv)?.trim();

    if (key === undefined || key === "") {
        throw new Error(
            "PI_POCKET_COLD_STORE_URL is set, but no key: set PI_POCKET_COLD_STORE_KEY_FILE (or PI_POCKET_COLD_STORE_KEY).",
        );
    }

    const hours = Number(env.PI_POCKET_COLD_STORE_AGE_HOURS ?? 24);

    if (!Number.isFinite(hours) || hours < 0) {
        throw new Error("PI_POCKET_COLD_STORE_AGE_HOURS must be a number of hours, 0 or more.");
    }

    return { client: new HttpColdClient(url, key), ageMs: hours * 60 * 60 * 1000 };
}

/** The cold store over HTTP, with a bearer key. Only https, or http to this machine (a local Worker). */
export class HttpColdClient implements ColdClient {
    readonly #base: string;
    readonly #key: string;
    readonly #timeoutMs: number;

    constructor(base: string, key: string, timeoutMs = 120_000) {
        const url = new URL(base);
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

        if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
            throw new Error("The cold store's address must be https (or http on this machine).");
        }

        this.#base = url.href.replace(/\/+$/, "");
        this.#key = key;
        this.#timeoutMs = timeoutMs;
    }

    /**
     * One request, in at most 3 attempts (2 retries) while the cold store does not answer, answers 5xx, or cuts the
     * answer off: every call is idempotent (a put replaces its rows, a seal with the same counts seals again, a remove of
     * nothing removes nothing). A refused key, a refusal of the Worker's own, and a conflict get no retry.
     */
    async #call(method: string, path: string, body?: string): Promise<unknown> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.#once(method, path, body);
            } catch (error) {
                if (!(error instanceof ColdUnavailable) || !error.retry || attempt >= 3) {
                    throw error;
                }

                await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 500 : 2_000));
            }
        }
    }

    async #once(method: string, path: string, body?: string): Promise<unknown> {
        let response: Response;

        try {
            response = await fetch(`${this.#base}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.#key}`,
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body }),
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
        } catch (error) {
            throw new ColdUnavailable(`The cold store did not answer: ${describe(error)}`);
        }

        const text = await response.text().catch(() => "");

        if (response.status === 409) {
            throw new ColdConflict(`The cold store refused it: ${text.slice(0, 200)}`);
        }

        if (!response.ok) {
            if (response.status === 413) {
                throw new ColdTooLarge(
                    `The cold store refused a request as too large: ${text.slice(0, 200)}`,
                );
            }

            if (response.status === 401) {
                throw new ColdUnavailable("The cold store refused the key.", false);
            }

            // The Worker's own refusals carry `error`; an answer without it came from the engine or the network in
            // front of it (Rivet's `consumer_closed` is a 400), and may work when tried again.
            const own = (() => {
                try {
                    return typeof (JSON.parse(text) as { error?: unknown }).error === "string";
                } catch {
                    return false;
                }
            })();

            // Its own words, which never hold the key or a record: `backup failed: …`, `recovery failed: …`.
            throw new ColdUnavailable(
                `The cold store answered ${response.status}: ${text.slice(0, 200)}`,
                !own ||
                    response.status >= 500 ||
                    response.status === 408 ||
                    response.status === 429,
            );
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new ColdUnavailable("The cold store answered with something that is not JSON.");
        }
    }

    async put(unit: string, rows: readonly ColdRow[]): Promise<void> {
        await this.#call("POST", `/v1/units/${unit}/rows`, putBody(rows.map(rowJson)));
    }

    async page(unit: string, after: number): Promise<{ rows: ColdRow[]; next: number | null }> {
        return (await this.#call("GET", `/v1/units/${unit}/rows?after=${after}`)) as {
            rows: ColdRow[];
            next: number | null;
        };
    }

    async summary(unit: string): Promise<{ rows: number; bytes: number; sealed: boolean }> {
        return (await this.#call("GET", `/v1/units/${unit}`)) as {
            rows: number;
            bytes: number;
            sealed: boolean;
        };
    }

    async seal(unit: string, rows: number, bytes: number): Promise<void> {
        await this.#call("POST", `/v1/units/${unit}/seal`, JSON.stringify({ rows, bytes }));
    }

    async remove(unit: string): Promise<void> {
        await this.#call("DELETE", `/v1/units/${unit}`);
    }
}

const rowJson = (row: ColdRow) =>
    JSON.stringify({ id: row.id, head: row.head, commit_seq: row.commit_seq, record: row.record });
const putBody = (rows: readonly string[]) => `{"rows":[${rows.join(",")}]}`;

/**
 * A new unit's name: the conversation and a random part, so that two Pocket servers that share a cold store never
 * write, read, or remove each other's units, and an archive never reuses a unit an earlier one left.
 */
export const newUnit = (id: number) => `conv-${id}-${randomBytes(12).toString("base64url")}`;

const sameRow = (a: ColdRow, b: ColdRow) =>
    a.id === b.id &&
    (a.head ?? null) === (b.head ?? null) &&
    a.commit_seq === b.commit_seq &&
    a.record === b.record;

const yieldToOthers = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One archive under way: `warm` asks it to stop, and waits for it. */
type Archiving = { stop: boolean; done: Promise<void>; since: number };

/**
 * A conversation `warm` let through this long before an archive of it began still counts as in use: the request that
 * asked may write to it after its check (a message, a send), and the archive must not delete under it.
 */
const IN_USE_MS = 2 * 60 * 1000;
/** How long `close` waits for a pass or a restore before it closes anyway (each stops at its next step). */
const CLOSE_MS = 15_000;

export class ColdStore {
    readonly #host: ColdHost;
    #db: SqliteDatabase | undefined;
    #reader: DatabaseSync | undefined;
    #client: ColdClient | undefined;
    #ageMs = DAY;
    #inUseMs = IN_USE_MS;
    #txRows = TX_ROWS;
    #requestBytes = PUT_BYTES;
    #onStep: ColdOptions["onStep"];
    /** Conversations whose rows are (or may partly be) only in the cold store: `deleting` and `archived`. */
    readonly #units = new Map<number, Unit>();
    /**
     * Units of archives a crash cut off before they deleted anything (`copying`, `sealed`): every row is still here, and
     * the next pass removes the unit, which this database made and recorded, and forgets the attempt.
     */
    readonly #abandoned = new Map<number, string>();
    readonly #archiving = new Map<number, Archiving>();
    readonly #restoring = new Map<number, Promise<void>>();
    /** When `warm` last let each conversation through: an archive does not delete what was used since `IN_USE_MS`. */
    readonly #used = new Map<number, number>();
    /** Conversations `guard` saw touched while cold, said once each in the log. */
    readonly #seenCold = new Set<number>();
    /** Each conversation's fork parent (`ConversationRecord.parent`), or null, as `guard` looked it up. */
    readonly #forkParent = new Map<number, number | null>();
    #pass: Promise<PassReport> | undefined;
    #lastPass: ColdStatus["lastPass"];
    #lastError: ColdStatus["lastError"];
    #closed = false;

    constructor(host: ColdHost) {
        this.#host = host;
    }

    get configured(): boolean {
        return this.#client !== undefined;
    }

    /**
     * After the storage opened, before the harness: read what is cold, and what a crash left. An archive cut off before
     * it deleted anything (`copying`, `sealed`) is not cold: its unit waits for the next pass to remove it. One cut off
     * while deleting stays cold: the next pass finishes it, or `warm` restores it.
     */
    async open(db: SqliteDatabase, path: string, options: ColdOptions | undefined): Promise<void> {
        this.#db = db;
        this.#client = options?.client;
        this.#ageMs = options?.ageMs ?? DAY;
        this.#inUseMs = options?.inUseMs ?? IN_USE_MS;
        this.#txRows = Math.max(1, options?.txRows ?? TX_ROWS);
        this.#requestBytes = options?.requestBytes ?? PUT_BYTES;
        this.#onStep = options?.onStep;

        const exists =
            (await db.get(
                `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
                TABLE,
            )) !== undefined;

        if (!exists && this.#client === undefined) {
            return;
        }

        await db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
            conversation_id INTEGER PRIMARY KEY,
            unit TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('copying', 'sealed', 'deleting', 'archived')),
            rows INTEGER NOT NULL,
            bytes INTEGER NOT NULL,
            last_entry INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            deleted_bytes INTEGER NOT NULL DEFAULT 0,
            requests INTEGER NOT NULL DEFAULT 0,
            last_prompt INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        ) STRICT`);
        // The ids of the verified cold copy, written with the state `deleting`: what a deletion deletes (and nothing
        // else), and where a read of an entry by its id alone finds its conversation.
        await db.exec(`CREATE TABLE IF NOT EXISTS ${ENTRIES} (
            id INTEGER PRIMARY KEY,
            conversation_id INTEGER NOT NULL
        ) STRICT`);
        await db.exec(
            `CREATE INDEX IF NOT EXISTS ${ENTRIES}_by_conversation ON ${ENTRIES} (conversation_id, id)`,
        );
        // Conversations a pass cannot archive (a record over the request limit), until their rows or the limit change.
        await db.exec(`CREATE TABLE IF NOT EXISTS ${SKIPS} (
            conversation_id INTEGER PRIMARY KEY,
            rows INTEGER NOT NULL,
            last_entry INTEGER NOT NULL,
            limit_bytes INTEGER NOT NULL,
            reason TEXT NOT NULL,
            at INTEGER NOT NULL
        ) STRICT`);

        for (const row of await db.all<{
            conversation_id: number;
            unit: string;
            state: ColdState;
            rows: number;
            bytes: number;
            last_entry: number;
            deleted_bytes: number;
            requests: number;
            last_prompt: number;
        }>(`SELECT * FROM ${TABLE}`)) {
            if (row.state === "copying" || row.state === "sealed") {
                this.#abandoned.set(row.conversation_id, row.unit);
                continue;
            }

            this.#units.set(row.conversation_id, {
                unit: row.unit,
                state: row.state,
                rows: row.rows,
                bytes: row.bytes,
                last: row.last_entry,
                freed: row.deleted_bytes,
                requests: row.requests,
                lastPrompt: row.last_prompt,
            });
        }

        if (this.#client !== undefined || this.#units.size > 0) {
            this.#reader = new DatabaseSync(path, { timeout: 5_000 });
            this.#reader.exec("PRAGMA query_only = 1");
        }
    }

    /** Whether a conversation's entries are in the cold store now (wholly, or partly while an archive was cut off). */
    isCold(id: ConversationId): boolean {
        return this.#units.has(Number(id));
    }

    /**
     * Before anything reads or writes a conversation's entries: bring them back if they are cold, and stop an archive of
     * it that is under way. Undefined, at once, for every other conversation. Rejects with a 503 for this conversation
     * alone when the cold store cannot give them back.
     */
    warm(id: ConversationId): Promise<void> | undefined {
        const key = Number(id);
        const archiving = this.#archiving.get(key);

        this.#used.set(key, Date.now());

        if (!this.#units.has(key) && archiving === undefined) {
            return undefined;
        }

        if (this.#closed) {
            return Promise.reject(
                new HttpError(
                    503,
                    `Conversation ${key} is in the cold store, and the server is stopping.`,
                ),
            );
        }

        let restoring = this.#restoring.get(key);

        if (restoring === undefined) {
            restoring = (async () => {
                if (archiving !== undefined) {
                    archiving.stop = true;
                    await archiving.done.catch(() => {});
                }

                if (this.#units.has(key)) {
                    await this.#restoreOrRefuse(key);
                }
            })().finally(() => {
                this.#restoring.delete(key);
                // Used from when the restore ends, too: a long one must not leave it open to the next pass.
                this.#used.set(key, Date.now());
            });
            this.#restoring.set(key, restoring);
        }

        return restoring;
    }

    /**
     * Durable's Storage, watched (see the top of this file). Every call goes through unchanged and nothing here throws:
     * a read past the two kept rows, a write, or a fork of a cold conversation first waits for its restore (a failed one
     * leaves the read as it would have been, and the conversation cold), and any touch stops an archive of it.
     */
    guard(storage: Storage): Storage {
        const wait = (id: ConversationId, how: "read" | "write") => this.#before(Number(id), how);

        const coldEntry = (id: unknown): number | undefined => {
            if (this.#units.size === 0 || this.#reader === undefined) {
                return undefined;
            }

            try {
                const row = this.#reader
                    .prepare(`SELECT conversation_id AS id FROM ${ENTRIES} WHERE id = ?`)
                    .get(Number(id)) as { id: number } | undefined;

                return row?.id;
            } catch {
                return undefined;
            }
        };

        const entry = (async (...args: unknown[]) => {
            const read = () =>
                (storage.entry as (...values: unknown[]) => Promise<unknown>)(...args);

            if (args.length === 3) {
                await wait(args[0] as ConversationId, "read");

                return read();
            }

            // By id alone: an entry that is not here and is in a cold copy belongs to that copy's conversation.
            const found = await read();
            const owner = found === undefined ? coldEntry(args[0]) : undefined;

            if (owner === undefined) {
                return found;
            }

            await wait(owner as ConversationId, "read");

            return read();
        }) as Storage["entry"];
        const guarded: Storage = {
            commit: async (batches, receive, context) => {
                const touched = new Set<number>();

                for (const batch of batches) {
                    for (const write of batch) {
                        if (
                            write.type === "entry" ||
                            write.type === "submission" ||
                            write.type === "task"
                        ) {
                            touched.add(Number(write.value.conversationId));
                        } else if (write.type === "conversation") {
                            const parent = write.value.parent?.conversationId;

                            this.#forkParent.set(
                                Number(write.value.id),
                                parent === undefined ? null : Number(parent),
                            );

                            // A new fork reads its parent's rows from now on.
                            if (parent !== undefined) {
                                touched.add(Number(parent));
                            }
                        }
                    }
                }

                for (const id of touched) {
                    await this.#before(id, "write");
                }

                return storage.commit(batches, receive, context);
            },
            mintId: () => storage.mintId(),
            conversation: (id, context) => storage.conversation(id, context),
            scanConversations: (query, limit, cursor, context) =>
                storage.scanConversations(query, limit, cursor, context),
            entry,
            findLatestHeadMarker: async (conversationId, atOrBefore, context) => {
                // The newest marker is one of the two rows kept here.
                if (atOrBefore !== undefined) {
                    await wait(conversationId, "read");
                }

                return storage.findLatestHeadMarker(conversationId, atOrBefore, context);
            },
            scanEntries: async (query, limit, cursor, context) => {
                // The newest entry alone (`latestEntryId`) is the other.
                const tail =
                    limit <= 1 &&
                    cursor === undefined &&
                    query.maxEntryId === undefined &&
                    (query.order ?? "descending") === "descending";

                if (!tail) {
                    await wait(query.conversationId, "read");
                }

                return storage.scanEntries(query, limit, cursor, context);
            },
            task: (id, context) => storage.task(id, context),
            scanTasks: (query, limit, cursor, context) =>
                storage.scanTasks(query, limit, cursor, context),
            submission: (id, context) => storage.submission(id, context),
            scanSubmissions: (query, limit, cursor, context) =>
                storage.scanSubmissions(query, limit, cursor, context),
            submissionByRequest: (conversationId, requestId, context) =>
                storage.submissionByRequest(conversationId, requestId, context),
            findDocument: (address, at, context) => storage.findDocument(address, at, context),
            document: (id, at, context) => storage.document(id, at, context),
            scanDocuments: (query, limit, cursor, context) =>
                storage.scanDocuments(query, limit, cursor, context),
            close: (context) => storage.close(context),
        };

        if (storage.publishing !== undefined) {
            guarded.publishing = (publish, context) => storage.publishing!(publish, context);
        }

        return guarded;
    }

    /**
     * What `guard` does before a read or write of a conversation's entries: stop an archive of it under way, and, when
     * it or a conversation it forks from is cold, wait for the restore, so that Durable never builds a context range
     * from a part of its rows (its scheduler keeps ranges, and would use one again after the restore). Resolves always.
     */
    async #before(id: number, how: "read" | "write"): Promise<void> {
        try {
            if (this.#archiving.size === 0 && this.#units.size === 0) {
                return;
            }

            for (
                let current: number | null = id, depth = 0;
                current !== null && depth < 32;
                depth++
            ) {
                const archiving = this.#archiving.get(current);

                if (archiving !== undefined) {
                    this.#used.set(current, Date.now());
                    archiving.stop = true;
                    // Stopped: it leaves the rows whole, or cold and restored just below.
                    await archiving.done.catch(() => {});
                }

                if (this.#units.has(current) && !this.#closed) {
                    if (!this.#seenCold.has(current)) {
                        this.#seenCold.add(current);
                        this.#host.log(
                            `Cold store: conversation ${current} was ${how === "write" ? "written" : "read"} past warm() while cold${current === id ? "" : ` (through its fork ${id})`}; restoring it first.`,
                        );
                    }

                    await this.warm(current as ConversationId)?.catch(() => {});
                }

                current = this.#forkParentOf(current);
            }
        } catch {
            // Never into Durable.
        }
    }

    /** The conversation `id` forks from, or null; read once from storage and kept (a record never changes). */
    #forkParentOf(id: number): number | null {
        const known = this.#forkParent.get(id);

        if (known !== undefined) {
            return known;
        }

        const row = this.#reader
            ?.prepare(
                `SELECT json_extract(record, '$.parent.conversationId') AS parent FROM conversations WHERE id = ?`,
            )
            .get(id) as { parent: number | null } | undefined;

        if (row === undefined) {
            // Not stored yet (a commit in flight), or no reader: look again next time.
            return null;
        }

        const parent = row.parent === null ? null : Number(row.parent);

        this.#forkParent.set(id, parent);

        return parent;
    }

    /** The request count and newest prompt size of an archived conversation, as they were when it was archived. */
    usageOf(id: ConversationId): { requests: number; lastPrompt: number } | undefined {
        const unit = this.#units.get(Number(id));

        return unit === undefined
            ? undefined
            : { requests: unit.requests, lastPrompt: unit.lastPrompt };
    }

    async status(withEligible = true): Promise<ColdStatus> {
        let rows = 0;
        let bytes = 0;
        let freedBytes = 0;
        let archived = 0;

        for (const unit of this.#units.values()) {
            rows += unit.rows;
            bytes += unit.bytes;
            freedBytes += unit.freed;

            if (unit.state === "archived") {
                archived++;
            }
        }

        const status: ColdStatus = {
            configured: this.configured,
            running: this.#pass !== undefined,
            archived,
            deleting: this.#units.size - archived,
            rows,
            bytes,
            freedBytes,
            tooLarge: this.#reader === undefined ? 0 : this.#skips().size,
            ...(this.#lastPass === undefined ? {} : { lastPass: this.#lastPass }),
            ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
        };

        if (withEligible && this.#reader !== undefined) {
            const { candidates } = await this.#eligible(this.#ageMs);

            status.eligible = {
                conversations: candidates.length,
                rows: candidates.reduce((sum, each) => sum + each.rows, 0),
            };
        }

        return status;
    }

    /**
     * Archive up to `limit` eligible subagents, the quiet longest first, one at a time; or (`dryRun`) only say which.
     * One pass at a time: a second one while one runs is refused.
     */
    async pass(
        options: { limit?: number; dryRun?: boolean; ageMs?: number } = {},
    ): Promise<PassReport> {
        if (this.#client === undefined || this.#reader === undefined) {
            throw new HttpError(409, "No cold store is set up (PI_POCKET_COLD_STORE_URL).");
        }

        if (this.#pass !== undefined) {
            throw new HttpError(409, "A cold store pass is already running.");
        }

        const pass = this.#run(options).finally(() => {
            this.#pass = undefined;
        });

        this.#pass = pass;

        return pass;
    }

    /**
     * Stop the pass under way at its next step, and wait for it and for restores, at most `CLOSE_MS` (a cold store that
     * does not answer would hold each request for its 3 attempts); then close the reader. Whatever is cut off is left
     * whole or cold, as a crash would leave it.
     */
    async close(): Promise<void> {
        this.#closed = true;

        for (const archiving of this.#archiving.values()) {
            archiving.stop = true;
        }

        let timer: NodeJS.Timeout | undefined;

        await Promise.race([
            Promise.allSettled([this.#pass, ...this.#restoring.values()]),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, CLOSE_MS);
                timer.unref();
            }),
        ]);
        clearTimeout(timer);
        this.#reader?.close();
        this.#reader = undefined;
    }

    async #run(options: { limit?: number; dryRun?: boolean; ageMs?: number }): Promise<PassReport> {
        const limit = Math.max(0, Math.floor(options.limit ?? 50));
        const ageMs = options.ageMs ?? this.#ageMs;
        const dryRun = options.dryRun === true;
        const report: PassReport = {
            dryRun,
            ageHours: ageMs / (60 * 60 * 1000),
            eligible: { conversations: 0, rows: 0 },
            skipped: {},
            selected: [],
            archived: { conversations: 0, rows: 0, bytes: 0, freedBytes: 0 },
            resumed: 0,
            cleaned: 0,
            failed: [],
        };

        // What `warm` let through long enough ago no longer counts as in use.
        for (const [id, at] of this.#used) {
            if (Date.now() - at > this.#inUseMs) {
                this.#used.delete(id);
            }
        }

        try {
            // Units a crash left before any row was deleted: removed (they are this database's), then forgotten.
            for (const [id, unit] of [...this.#abandoned]) {
                if (dryRun || this.#closed) {
                    break;
                }

                await this.#client!.remove(unit);
                await this.#db!.run(
                    `DELETE FROM ${TABLE} WHERE conversation_id = ? AND unit = ? AND state IN ('copying', 'sealed')`,
                    id,
                    unit,
                );
                this.#abandoned.delete(id);
                report.cleaned++;
            }

            const { candidates, skipped } = await this.#eligible(ageMs);
            const selected = candidates.slice(0, limit);

            await this.#measure(dryRun ? candidates : selected);
            report.eligible = {
                conversations: candidates.length,
                rows: candidates.reduce((sum, each) => sum + each.rows, 0),
                ...(dryRun
                    ? { bytes: candidates.reduce((sum, each) => sum + (each.bytes ?? 0), 0) }
                    : {}),
            };
            report.skipped = skipped;
            report.selected = selected.map(({ id, rows, bytes }) => ({
                id,
                rows,
                bytes: bytes ?? 0,
            }));

            if (!dryRun) {
                // Deletions cut off by a crash or a stop first: their conversations are cold until finished or restored.
                for (const [id, unit] of [...this.#units]) {
                    if (unit.state === "deleting" && !this.#closed) {
                        await this.#exclusive(id, (archiving) => this.#delete(id, archiving));
                        report.resumed++;
                    }
                }

                for (const candidate of selected) {
                    if (this.#closed) {
                        report.stopped = "The server is stopping.";
                        break;
                    }

                    try {
                        const done = await this.#exclusive(candidate.id, (archiving) =>
                            this.#archive(candidate.id, archiving),
                        );

                        if (done !== undefined) {
                            report.archived.conversations++;
                            report.archived.rows += done.rows;
                            report.archived.bytes += done.bytes;
                            report.archived.freedBytes += done.freed;
                        }
                    } catch (error) {
                        if (error instanceof ColdUnavailable) {
                            throw error;
                        }

                        if (error instanceof ColdTooLarge) {
                            // This conversation's failure, not the pass's: skipped until its rows or the limit change.
                            const now =
                                error.rows >= 0
                                    ? { rows: error.rows, last: error.last }
                                    : (this.#reader!.prepare(
                                          `SELECT count(*) AS rows, coalesce(max(id), 0) AS last FROM entries WHERE conversation_id = ?`,
                                      ).get(candidate.id) as { rows: number; last: number });

                            await this.#db!.run(
                                `INSERT OR REPLACE INTO ${SKIPS} (conversation_id, rows, last_entry, limit_bytes, reason, at)
                                    VALUES (?, ?, ?, ?, ?, ?)`,
                                candidate.id,
                                now.rows,
                                now.last,
                                this.#requestBytes,
                                error.message,
                                this.#host.now(),
                            );
                        }

                        report.failed.push({ id: candidate.id, error: describe(error) });
                        this.#noteError(describe(error), candidate.id);
                    }
                }
            }
        } catch (error) {
            report.stopped = describe(error);
            this.#noteError(describe(error));
        }

        this.#lastPass = {
            at: this.#host.now(),
            dryRun,
            archived: report.archived.conversations,
            bytes: report.archived.bytes,
            failed: report.failed.length,
        };

        return report;
    }

    /** Run one conversation's archive work alone: `warm` finds it in `#archiving`, asks it to stop, and waits. */
    async #exclusive<T>(id: number, work: (archiving: Archiving) => Promise<T>): Promise<T> {
        // Known before anything waits, so a `warm` from now on stops it rather than reading under it.
        const archiving: Archiving = { stop: false, done: Promise.resolve(), since: Date.now() };
        const done = (async () => {
            // A restore under way finishes first.
            await this.#restoring.get(id)?.catch(() => {});

            return work(archiving);
        })();

        archiving.done = done.then(
            () => {},
            () => {},
        );
        this.#archiving.set(id, archiving);

        try {
            return await done;
        } finally {
            if (this.#archiving.get(id) === archiving) {
                this.#archiving.delete(id);
            }
        }
    }

    /** Conversations a pass skips as too large, with the rows, newest entry, and limit they were too large at. */
    #skips(): Map<number, { rows: number; last: number; limit: number }> {
        return new Map(
            (
                this.#reader!.prepare(
                    `SELECT conversation_id AS id, rows, last_entry AS last, limit_bytes AS "limit" FROM ${SKIPS}`,
                ).all() as { id: number; rows: number; last: number; limit: number }[]
            ).map(({ id, ...rest }) => [id, rest]),
        );
    }

    /**
     * The subagents a pass may archive now, and why each other one may not. Each condition is read from storage, or
     * from what the app has open, at the time of the pass; `#stillQuiet` checks the ones that can change again in each
     * transaction before it deletes anything.
     */
    async #eligible(
        ageMs: number,
    ): Promise<{ candidates: ColdCandidate[]; skipped: Record<string, number> }> {
        const reader = this.#reader!;
        const skipped: Record<string, number> = {};

        const skip = (why: string) => {
            skipped[why] = (skipped[why] ?? 0) + 1;
        };

        const ids = (sql: string, ...params: string[]) =>
            new Set(
                (reader.prepare(sql).all(...params) as { id: number | null }[]).flatMap((row) =>
                    row.id === null ? [] : [Number(row.id)],
                ),
            );
        // Conversations forked from another (`ConversationRecord.parent`): the fork reads its parent's rows.
        const forked = ids(
            `SELECT DISTINCT json_extract(record, '$.parent.conversationId') AS id FROM conversations
                WHERE json_extract(record, '$.parent') IS NOT NULL`,
        );
        // A reporter that has not ended: it may still send to the subagent, or read its answer (`subagents.ts`).
        const reporting = ids(
            `SELECT json_extract(record, '$.input.conversationId') AS id FROM tasks
                WHERE kind = ? AND status IN ${LIVE_TASK}`,
            REPORTER,
        );
        const working = ids(
            `SELECT DISTINCT conversation_id AS id FROM tasks WHERE status IN ${LIVE_TASK}`,
        );
        const waiting = ids(
            `SELECT DISTINCT conversation_id AS id FROM submissions WHERE status IN ('queued', 'placed')`,
        );
        const owned = reader
            .prepare(
                `SELECT id, owner_conversation_id AS owner FROM conversations
                    WHERE owner_conversation_id IS NOT NULL ORDER BY id`,
            )
            .all() as { id: number; owner: number }[];
        const newest = reader.prepare(
            `SELECT (SELECT max(json_extract(m.value, '$.timestamp')) FROM json_each(e.record, '$.model') AS m) AS at
                FROM entries AS e WHERE e.conversation_id = ? ORDER BY e.id DESC LIMIT 8`,
        );
        // The index alone: no record is read.
        const count = reader.prepare(
            `SELECT count(*) AS rows, coalesce(max(id), 0) AS last FROM entries WHERE conversation_id = ?`,
        );
        const tooLarge = this.#skips();
        const docs = new Map<number, SubagentsLike | undefined>();

        const doc = async (id: number) => {
            if (!docs.has(id)) {
                docs.set(id, await this.#host.subagents(id as ConversationId));
            }

            return docs.get(id);
        };

        const now = this.#host.now();
        const candidates: ColdCandidate[] = [];

        for (const [index, { id, owner }] of owned.entries()) {
            if (index % 64 === 63) {
                await yieldToOthers();
            }

            const conversation = id as ConversationId;

            if (this.#units.has(id)) {
                continue;
            }

            if (this.#abandoned.has(id)) {
                skip("cut-off attempt not removed");
                continue;
            }

            if (this.#host.parentOf(conversation) !== (owner as ConversationId)) {
                skip("not a subagent");
                continue;
            }

            if (this.#host.hasRoom(conversation)) {
                skip("open");
                continue;
            }

            if (Date.now() - (this.#used.get(id) ?? -Infinity) < this.#inUseMs) {
                skip("used just now");
                continue;
            }

            if (this.#host.isBusy(conversation) || working.has(id)) {
                skip("working");
                continue;
            }

            if (waiting.has(id)) {
                skip("message waiting");
                continue;
            }

            if (forked.has(id)) {
                skip("forked");
                continue;
            }

            if (reporting.has(id)) {
                skip("report not taken");
                continue;
            }

            const own = await doc(id);

            if ((own?.outbox?.length ?? 0) > 0 || own?.sending !== undefined) {
                skip("own reports waiting");
                continue;
            }

            const parent = await doc(owner);
            const name = Object.entries(parent?.agents ?? {}).find(
                ([, record]) => Number(record.conversationId) === id,
            )?.[0];

            if (
                name === undefined ||
                parent?.outbox?.some((report) => report.name === name) === true ||
                parent?.sending?.reports.some((report) => report.name === name) === true
            ) {
                skip("report not taken");
                continue;
            }

            const times = (newest.all(id) as { at: number | null }[]).flatMap((row) =>
                typeof row.at === "number" ? [row.at] : [],
            );

            if (times.length === 0) {
                skip(newest.all(id).length === 0 ? "no entries" : "no time");
                continue;
            }

            const quietSince = Math.max(...times);

            if (now - quietSince < ageMs) {
                skip("recent");
                continue;
            }

            const size = count.get(id) as { rows: number; last: number };
            const large = tooLarge.get(id);

            if (
                large !== undefined &&
                large.rows === size.rows &&
                large.last === size.last &&
                large.limit === this.#requestBytes
            ) {
                skip("too large");
                continue;
            }

            candidates.push({ id, rows: size.rows, quietSince });
        }

        candidates.sort((a, b) => a.quietSince - b.quietSince || a.id - b.id);

        return { candidates, skipped };
    }

    /** The UTF-8 bytes of each candidate's records, one conversation at a time between other work. */
    async #measure(candidates: ColdCandidate[]): Promise<void> {
        const bytes = this.#reader!.prepare(
            `SELECT coalesce(sum(octet_length(record)), 0) AS bytes FROM entries WHERE conversation_id = ?`,
        );

        for (const candidate of candidates) {
            candidate.bytes = (bytes.get(candidate.id) as { bytes: number }).bytes;
            await yieldToOthers();
        }
    }

    /** Whether nothing can have started in the conversation since the pass chose it. On Durable's line, in `tx`. */
    async #stillQuiet(
        tx: SqliteExecutor,
        id: number,
        last: number,
        archiving: Archiving,
    ): Promise<string | undefined> {
        if (archiving.stop) {
            return "stopped";
        }

        if ((this.#used.get(id) ?? 0) > archiving.since - this.#inUseMs) {
            return "it was used";
        }

        if (
            (await tx.get(
                `SELECT 1 AS found FROM entries WHERE conversation_id = ? AND id > ? LIMIT 1`,
                id,
                last,
            )) !== undefined
        ) {
            return "it has new entries";
        }

        if (
            (await tx.get(
                `SELECT 1 AS found FROM tasks WHERE conversation_id = ? AND status IN ${LIVE_TASK} LIMIT 1`,
                id,
            )) !== undefined
        ) {
            return "it has work under way";
        }

        if (
            (await tx.get(
                `SELECT 1 AS found FROM submissions WHERE conversation_id = ? AND status IN ('queued', 'placed') LIMIT 1`,
                id,
            )) !== undefined
        ) {
            return "a message waits for it";
        }

        if (
            (await tx.get(
                `SELECT 1 AS found FROM tasks WHERE status IN ${LIVE_TASK} AND kind = ?
                    AND json_extract(record, '$.input.conversationId') = ? LIMIT 1`,
                REPORTER,
                id,
            )) !== undefined
        ) {
            return "a report of it is on its way";
        }

        if (
            (await tx.get(
                `SELECT 1 AS found FROM conversations WHERE json_extract(record, '$.parent.conversationId') = ? LIMIT 1`,
                id,
            )) !== undefined
        ) {
            return "a conversation forks from it";
        }

        if (this.#host.hasRoom(id as ConversationId) || this.#host.isBusy(id as ConversationId)) {
            return "it is open";
        }

        return undefined;
    }

    async #step(step: ColdStep, id: number): Promise<void> {
        await this.#onStep?.(step, id);
    }

    /**
     * One conversation: copy its rows to a new unit, seal it, read it all back and compare, and only then delete the
     * local rows, a small transaction at a time. Undefined when it stopped before deleting anything (`warm`, or it is no
     * longer quiet): its rows are all here.
     */
    async #archive(
        id: number,
        archiving: Archiving,
    ): Promise<{ rows: number; bytes: number; freed: number } | undefined> {
        const db = this.#db!;
        const reader = this.#reader!;
        const client = this.#client!;
        const unit = newUnit(id);
        const size = reader
            .prepare(
                `SELECT count(*) AS rows, coalesce(sum(octet_length(record)), 0) AS bytes, coalesce(max(id), 0) AS last
                    FROM entries WHERE conversation_id = ?`,
            )
            .get(id) as { rows: number; bytes: number; last: number };

        if (size.rows === 0) {
            return undefined;
        }

        // Recorded before anything is sent: a unit this database never recorded is never removed by it.
        await db.run(
            `INSERT INTO ${TABLE} (conversation_id, unit, state, rows, bytes, last_entry, updated_at)
                VALUES (?, ?, 'copying', ?, ?, ?, ?)`,
            id,
            unit,
            size.rows,
            size.bytes,
            size.last,
            this.#host.now(),
        );

        let deleting = false;

        try {
            await this.#step("copying", id);

            const { sizes, requests, lastPrompt } = await this.#upload(id, unit, size, archiving);

            if (sizes === undefined) {
                await this.#forget(id, unit);

                return undefined;
            }

            const counted = sizes.reduce((sum, [, bytes]) => sum + bytes, 0);

            if (sizes.length !== size.rows || counted !== size.bytes) {
                throw new ColdMismatch(
                    `Conversation ${id} changed while it was copied (${sizes.length} rows, ${size.rows} counted).`,
                );
            }

            await this.#step("uploaded", id);

            try {
                await client.seal(unit, size.rows, size.bytes);
            } catch (error) {
                throw error instanceof ColdConflict
                    ? new ColdMismatch(
                          `The cold copy of conversation ${id} has other counts: ${error.message}`,
                      )
                    : error;
            }

            await db.run(
                `UPDATE ${TABLE} SET state = 'sealed', requests = ?, last_prompt = ?, updated_at = ? WHERE conversation_id = ?`,
                requests,
                lastPrompt,
                this.#host.now(),
                id,
            );
            await this.#step("sealed", id);

            if (!(await this.#verify(id, unit, size.rows, size.last, archiving))) {
                await this.#forget(id, unit);

                return undefined;
            }

            await this.#step("verified", id);

            const keep = await this.#kept(db, id, size.last);
            const doomed = sizes.flatMap(([row]) => (keep.has(row) ? [] : [row]));
            // From here the cold copy stands for the rows: the state says so, with the exact ids a deletion may delete,
            // in the same transaction as the check that nothing started.
            const why = await db.transaction(async (tx) => {
                const reason = await this.#stillQuiet(tx, id, size.last, archiving);

                if (reason !== undefined) {
                    return reason;
                }

                await tx.run(
                    `UPDATE ${TABLE} SET state = 'deleting', updated_at = ? WHERE conversation_id = ?`,
                    this.#host.now(),
                    id,
                );

                for (let from = 0; from < doomed.length; from += 500) {
                    await tx.run(
                        `INSERT INTO ${ENTRIES} (id, conversation_id) SELECT value, ? FROM json_each(?)`,
                        id,
                        JSON.stringify(doomed.slice(from, from + 500)),
                    );
                }

                return undefined;
            });

            if (why !== undefined) {
                await this.#forget(id, unit);
                this.#host.log(`Cold store: conversation ${id} stays here: ${why}.`);

                return undefined;
            }

            deleting = true;

            const cold: Unit = {
                unit,
                state: "deleting",
                rows: size.rows,
                bytes: size.bytes,
                last: size.last,
                freed: 0,
                requests,
                lastPrompt,
            };

            this.#units.set(id, cold);
            await this.#step("deleting", id);
            await this.#delete(id, archiving);

            return this.#units.get(id) === cold && cold.state === "archived"
                ? { rows: size.rows, bytes: size.bytes, freed: cold.freed }
                : undefined;
        } catch (error) {
            // Before `deleting`, every row is still here: forget the attempt. After it, the state stays.
            if (!deleting) {
                await this.#forget(id, unit).catch(() => {});
            }

            throw error;
        }
    }

    /** Forget an attempt that deleted nothing, and remove its unit (recorded by this database), as far as it can. */
    async #forget(id: number, unit: string): Promise<void> {
        await this.#db!.run(
            `DELETE FROM ${TABLE} WHERE conversation_id = ? AND unit = ? AND state IN ('copying', 'sealed')`,
            id,
            unit,
        );
        await this.#client!.remove(unit).catch((error: unknown) => {
            this.#host.log(`Cold store: unit ${unit} stays in the cold store: ${describe(error)}`);
        });
    }

    /**
     * Send the rows up to `last`, in id order, a request at a time, each under the request limit. Returns each row's
     * id and size, and the request count and newest prompt the usage route reads from the entries
     * (`conversation-usage.ts`); no sizes when stopped. A single row over the limit fails this conversation alone
     * (`ColdTooLarge`), before anything is sent.
     */
    async #upload(
        id: number,
        unit: string,
        size: { rows: number; last: number },
        archiving: Archiving,
    ): Promise<{ sizes?: [number, number][]; requests: number; lastPrompt: number }> {
        const reader = this.#reader!;
        const limit = this.#requestBytes;
        const wrapper = Buffer.byteLength(putBody([]));
        const largest = reader
            .prepare(
                `SELECT id, octet_length(record) AS bytes FROM entries WHERE conversation_id = ? AND id <= ?
                    ORDER BY octet_length(record) DESC LIMIT 1`,
            )
            .get(id, size.last) as { id: number; bytes: number };

        // The record's bytes are a floor of its JSON's: a row that cannot fit is known before anything is sent.
        if (largest.bytes + wrapper > limit) {
            throw new ColdTooLarge(
                `Entry ${largest.id} of conversation ${id} is ${largest.bytes} bytes, over the cold store's request limit of ${limit}.`,
                size.rows,
                size.last,
            );
        }

        const read = reader.prepare(
            `SELECT id, head, commit_seq, record FROM entries WHERE conversation_id = ? AND id > ? AND id <= ?
                ORDER BY id LIMIT ${READ_ROWS}`,
        );
        const sizes: [number, number][] = [];
        let requests = 0;
        let lastPrompt = 0;
        let batch: ColdRow[] = [];
        let batchBytes = wrapper;
        let after = 0;

        const flush = async () => {
            if (batch.length > 0) {
                await this.#client!.put(unit, batch);
                batch = [];
                batchBytes = wrapper;
            }
        };

        for (;;) {
            if (archiving.stop) {
                return { requests, lastPrompt };
            }

            const rows = read.all(id, after, size.last) as ColdRow[];

            if (rows.length === 0) {
                break;
            }

            for (const row of rows) {
                // Its JSON, and the comma before it.
                const bytes = Buffer.byteLength(rowJson(row)) + 1;

                if (bytes + wrapper > limit) {
                    throw new ColdTooLarge(
                        `Entry ${row.id} of conversation ${id} is ${bytes} bytes as JSON, over the cold store's request limit of ${limit}.`,
                        size.rows,
                        size.last,
                    );
                }

                if (batch.length > 0 && batchBytes + bytes > limit) {
                    await flush();
                }

                batch.push(row);
                batchBytes += bytes;
                sizes.push([row.id, Buffer.byteLength(row.record)]);

                // As `conversation-usage.ts` counts them: this conversation's own model responses.
                if (row.record.includes(`"kind":"pi.assistant"`)) {
                    const entry = JSON.parse(row.record) as {
                        kind?: string;
                        conversationId?: number;
                        model?: {
                            role?: string;
                            usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
                        }[];
                    };

                    if (entry.kind === "pi.assistant" && Number(entry.conversationId) === id) {
                        for (const message of entry.model ?? []) {
                            if (message.role === "assistant") {
                                requests++;

                                const used = message.usage;
                                const prompt =
                                    (used?.input ?? 0) +
                                    (used?.cacheRead ?? 0) +
                                    (used?.cacheWrite ?? 0);

                                if (prompt > 0) {
                                    lastPrompt = prompt;
                                }
                            }
                        }
                    }
                }
            }

            after = rows.at(-1)!.id;
            await yieldToOthers();
        }

        await flush();

        return { sizes, requests, lastPrompt };
    }

    /**
     * Read the sealed unit back, page by page, and compare every row with the local one: id, head, commit seq, and the
     * record's text. False when stopped; throws `ColdMismatch` on any difference.
     */
    async #verify(
        id: number,
        unit: string,
        rows: number,
        last: number,
        archiving: Archiving,
    ): Promise<boolean> {
        const client = this.#client!;
        const summary = await client.summary(unit);

        if (!summary.sealed || summary.rows !== rows) {
            throw new ColdMismatch(
                `The cold copy of conversation ${id} is not sealed with ${rows} rows.`,
            );
        }

        const local = this.#reader!.prepare(
            `SELECT id, head, commit_seq, record FROM entries WHERE conversation_id = ? AND id > ? AND id <= ?
                ORDER BY id LIMIT ?`,
        );
        let after = 0;
        let seen = 0;

        for (;;) {
            if (archiving.stop) {
                return false;
            }

            const page = await client.page(unit, after);

            if (page.rows.length > 0) {
                const upper = page.rows.at(-1)!.id;
                const mine = local.all(id, after, upper, page.rows.length + 1) as ColdRow[];

                if (
                    mine.length !== page.rows.length ||
                    mine.some((row, index) => !sameRow(row, page.rows[index]!))
                ) {
                    throw new ColdMismatch(
                        `The cold copy of conversation ${id} differs from its rows here, after entry ${after}.`,
                    );
                }

                seen += page.rows.length;
                after = upper;
            }

            if (page.next === null) {
                break;
            }

            if (page.next !== after) {
                throw new ColdMismatch(`The cold store paged conversation ${id} out of order.`);
            }

            await yieldToOthers();
        }

        // Nothing local past the last cold row either, up to `last`.
        if (seen !== rows || local.all(id, after, last, 1).length > 0) {
            throw new ColdMismatch(
                `The cold copy of conversation ${id} has ${seen} of its ${rows} rows.`,
            );
        }

        return true;
    }

    /**
     * The rows of a conversation that stay here when it is archived: its newest entry and its newest head marker, the
     * two Durable keeps in memory once read (see the top of this file).
     */
    async #kept(executor: SqliteExecutor, id: number, last: number): Promise<Set<number>> {
        const row = await executor.get<{ newest: number | null; marker: number | null }>(
            `SELECT
                (SELECT max(id) FROM entries WHERE conversation_id = ? AND id <= ?) AS newest,
                (SELECT max(id) FROM entries WHERE conversation_id = ? AND id <= ? AND head IS NOT NULL) AS marker`,
            id,
            last,
            id,
            last,
        );

        return new Set(
            [row?.newest, row?.marker].flatMap((each) => (each == null ? [] : [Number(each)])),
        );
    }

    /**
     * Delete, here, exactly the rows whose ids the verified cold copy holds (`pocket_cold_entries`, written with the
     * state `deleting`), a small transaction at a time; each one counts what it deleted in the state. The same for a
     * fresh archive and for one a crash or a stop cut off: it takes the ids still here.
     */
    async #delete(id: number, archiving: Archiving): Promise<void> {
        const db = this.#db!;
        const unit = this.#units.get(id);

        // Restored meanwhile.
        if (unit?.state !== "deleting") {
            return;
        }

        for (;;) {
            const done = await db.transaction(
                async (tx): Promise<{ reason?: string; finished?: true; bytes?: number }> => {
                    const reason = await this.#stillQuiet(tx, id, unit.last, archiving);

                    if (reason !== undefined) {
                        return { reason };
                    }

                    const here = await tx.all<{ id: number; bytes: number }>(
                        `SELECT c.id, octet_length(e.record) AS bytes FROM ${ENTRIES} AS c JOIN entries AS e ON e.id = c.id
                            WHERE c.conversation_id = ? ORDER BY c.id LIMIT ?`,
                        id,
                        this.#txRows,
                    );
                    const batch: number[] = [];
                    let bytes = 0;

                    for (const row of here) {
                        if (batch.length > 0 && bytes + row.bytes > TX_BYTES) {
                            break;
                        }

                        batch.push(row.id);
                        bytes += row.bytes;
                    }

                    if (batch.length === 0) {
                        return { finished: true };
                    }

                    const deleted = await tx.runCounted(
                        `DELETE FROM entries WHERE conversation_id = ? AND id IN (SELECT value FROM json_each(?))`,
                        id,
                        JSON.stringify(batch),
                    );

                    if (deleted !== batch.length) {
                        throw new ColdMismatch(
                            `Conversation ${id} had ${deleted} of the ${batch.length} rows to delete.`,
                        );
                    }

                    await tx.run(
                        `UPDATE ${TABLE} SET deleted = deleted + ?, deleted_bytes = deleted_bytes + ?, updated_at = ?
                            WHERE conversation_id = ?`,
                        deleted,
                        bytes,
                        this.#host.now(),
                        id,
                    );

                    return { bytes };
                },
            );

            if (done.reason !== undefined) {
                // Stopped by `warm`, which restores it next; or something started there, which no path should allow.
                if (done.reason !== "stopped") {
                    this.#host.log(
                        `Cold store: conversation ${id} came back while archived: ${done.reason}.`,
                    );
                    await this.#restore(id);
                }

                return;
            }

            if (done.finished === true) {
                break;
            }

            unit.freed += done.bytes ?? 0;
            await this.#step("deleted-batch", id);
            await yieldToOthers();
        }

        await db.transaction(async (tx) => {
            const keep = await this.#kept(tx, id, unit.last);

            if (keep.size === 0) {
                throw new ColdMismatch(`Conversation ${id} lost the rows it keeps here.`);
            }

            await tx.run(
                `UPDATE ${TABLE} SET state = 'archived', updated_at = ? WHERE conversation_id = ?`,
                this.#host.now(),
                id,
            );
        });
        unit.state = "archived";
        await this.#step("archived", id);
    }

    async #restoreOrRefuse(id: number): Promise<void> {
        if (this.#client === undefined) {
            throw new HttpError(
                503,
                `Conversation ${id} is in the cold store, and no cold store is set up to bring it back (PI_POCKET_COLD_STORE_URL).`,
            );
        }

        try {
            await this.#restore(id);
        } catch (error) {
            this.#noteError(`Restore failed: ${describe(error)}`, id);

            throw new HttpError(
                503,
                `Conversation ${id} is in the cold store and could not be brought back: ${describe(error)}`,
            );
        }
    }

    /**
     * Put a cold conversation's rows back exactly as they were, from the unit its state names, a small transaction at a
     * time; a row already here (one it keeps, or one an earlier cut-off restore put back) must equal its cold copy.
     * The state goes in the last transaction, once the copy's rows and bytes add up to what was archived: until then
     * the conversation stays cold, and a retry goes on.
     */
    async #restore(id: number): Promise<void> {
        const db = this.#db!;
        const client = this.#client!;
        const unit = this.#units.get(id);

        if (unit === undefined) {
            return;
        }

        let after = 0;
        let rows = 0;
        let bytes = 0;

        for (;;) {
            const page = await client.page(unit.unit, after);

            for (const row of page.rows) {
                const entry = JSON.parse(row.record) as { id?: unknown; conversationId?: unknown };

                if (
                    row.id <= after ||
                    Number(entry.id) !== row.id ||
                    Number(entry.conversationId) !== id
                ) {
                    throw new ColdMismatch(
                        `The cold copy of conversation ${id} holds a row out of order or of another.`,
                    );
                }

                after = row.id;
                rows++;
                bytes += Buffer.byteLength(row.record);
            }

            for (let from = 0; from < page.rows.length;) {
                let to = from;
                let size = 0;

                while (
                    to < page.rows.length &&
                    to - from < this.#txRows &&
                    (to === from || size + page.rows[to]!.record.length <= TX_BYTES)
                ) {
                    size += page.rows[to]!.record.length;
                    to++;
                }

                const slice = page.rows.slice(from, to);

                await db.transaction(async (tx) => {
                    for (const row of slice) {
                        const added = await tx.runCounted(
                            `INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT (id) DO NOTHING`,
                            row.id,
                            id,
                            row.head ?? null,
                            row.commit_seq,
                            row.record,
                        );

                        if (added === 0) {
                            const here = await tx.get<ColdRow & { conversation_id: number }>(
                                `SELECT id, conversation_id, head, commit_seq, record FROM entries WHERE id = ?`,
                                row.id,
                            );

                            if (
                                here === undefined ||
                                here.conversation_id !== id ||
                                !sameRow(here, row)
                            ) {
                                throw new ColdMismatch(
                                    `Entry ${row.id} of conversation ${id} differs from its cold copy.`,
                                );
                            }
                        }
                    }
                });
                from = to;
                await yieldToOthers();
            }

            if (page.next === null) {
                break;
            }

            // As `#verify`: each page starts after the last one's last row.
            if (page.next !== after) {
                throw new ColdMismatch(`The cold store paged conversation ${id} out of order.`);
            }
        }

        if (rows !== unit.rows || bytes !== unit.bytes) {
            throw new ColdMismatch(
                `The cold copy of conversation ${id} holds ${rows} rows of ${bytes} bytes, not ${unit.rows} of ${unit.bytes}.`,
            );
        }

        await db.transaction(async (tx) => {
            await tx.run(`DELETE FROM ${ENTRIES} WHERE conversation_id = ?`, id);
            await tx.run(
                `DELETE FROM ${TABLE} WHERE conversation_id = ? AND unit = ?`,
                id,
                unit.unit,
            );
        });
        this.#units.delete(id);
        this.#seenCold.delete(id);
        this.#used.set(id, Date.now());
        this.#host.log(`Cold store: conversation ${id} is back (${unit.rows} entries).`);
        // The rows are whole here again: this database's unit goes from the Worker (its Tigris copy stays until an
        // operator purges it). Not waited for: a restore that `guard` waits on must not wait on this too.
        void client.remove(unit.unit).catch((error: unknown) => {
            this.#host.log(
                `Cold store: unit ${unit.unit} stays in the cold store: ${describe(error)}`,
            );
        });
    }

    #noteError(message: string, conversationId?: number): void {
        this.#lastError = {
            at: this.#host.now(),
            ...(conversationId === undefined ? {} : { conversationId }),
            message,
        };
        this.#host.log(
            `Cold store${conversationId === undefined ? "" : ` (conversation ${conversationId})`}: ${message}`,
        );
    }
}
