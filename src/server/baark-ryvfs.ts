/**
 * Baark (`ruttr workspace`) and RyvFS composite helpers for zero-disk copy-on-write worktrees and native Pijul
 * repositories. Git repositories without initialized RyvFS stores fall back to Git worktrees seamlessly.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitDirOf } from "./branches.ts";
import { describe, HttpError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export type WorktreeShape = {
    path: string;
    branch: string;
    source: string;
};

type WhichInfo = {
    workspace?: string;
    file?: string | null;
    repo?: string | null;
    canonical?: string | null;
    class?: string | null;
    branch?: string | null;
    checkout?: string | null;
};

type OpenContext = {
    composite?: {
        forked?: boolean;
    };
};

type RyvfsSidecar = {
    kind: "ryvfs-compose";
    repo: string;
    sourceCheckout: string;
    workspaceFile: string;
};

const CLI_TIMEOUT_MS = 60_000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024;

/** Walk upward from `cwd` looking for a Baark `workspace.kdl` manifest, or fall back to `$BAARK_WORKSPACE`. */
export function baarkWorkspaceFileOf(cwd: string): string | undefined {
    try {
        for (let folder = resolve(cwd); ; folder = dirname(folder)) {
            const candidate = join(folder, "workspace.kdl");
            const found = statSync(candidate, { throwIfNoEntry: false });

            if (found?.isFile()) {
                return candidate;
            }

            if (dirname(folder) === folder) {
                break;
            }
        }
    } catch {
        // Permission errors or dead mounts act as absent manifests so UI views never crash.
    }

    const fromEnv = process.env.BAARK_WORKSPACE?.trim();

    if (fromEnv && statSync(fromEnv, { throwIfNoEntry: false })?.isFile()) {
        return fromEnv;
    }

    return undefined;
}

/** Walk upward from `cwd` looking for a native `.pijul` repository folder. */
export function pijulDirOf(cwd: string): string | undefined {
    try {
        for (let folder = resolve(cwd); ; folder = dirname(folder)) {
            const dotPijul = join(folder, ".pijul");
            const found = statSync(dotPijul, { throwIfNoEntry: false });

            if (found?.isDirectory()) {
                return dotPijul;
            }

            if (dirname(folder) === folder) {
                return undefined;
            }
        }
    } catch {
        return undefined;
    }
}

/** Walk upward from `cwd` looking for an open RyvFS composite workspace (`composite.json` or `.ryvfs-compose`). */
export function ryvfsComposeDirOf(cwd: string): string | undefined {
    try {
        for (let folder = resolve(cwd); ; folder = dirname(folder)) {
            if (
                statSync(join(folder, ".ryvfs-compose"), { throwIfNoEntry: false })?.isFile() ||
                statSync(`${folder}.manifest.json`, { throwIfNoEntry: false })?.isFile() ||
                statSync(`${folder}.pocket.json`, { throwIfNoEntry: false })?.isFile()
            ) {
                return folder;
            }

            if (dirname(folder) === folder) {
                return undefined;
            }
        }
    } catch {
        return undefined;
    }
}

/** Active channel name recorded in `.pijul/config`, or `"main"` by default. */
export function pijulHeadOf(pijulDir: string): string {
    try {
        const config = readFileSync(join(pijulDir, "config"), "utf8");
        const matched =
            /^\s*current_channel\s*=\s*"([^"]+)"/m.exec(config) ??
            /^\s*default_channel\s*=\s*"([^"]+)"/m.exec(config);

        return matched?.[1]?.trim() || "main";
    } catch {
        return "main";
    }
}

/** Resolve the `ruttr` CLI executable (`PI_POCKET_RUTTR_BIN`, `~/.local/bin/ruttr`, or `"ruttr"`). */
export function ruttrBin(): string {
    const configured = process.env.PI_POCKET_RUTTR_BIN?.trim();

    if (configured) {
        return configured;
    }

    const local = join(homedir(), ".local", "bin", "ruttr");

    return existsSync(local) ? local : "ruttr";
}

/** Resolve the `ryvfs` CLI executable (`PI_POCKET_RYVFS_BIN`, `~/.local/bin/ryvfs`, or `"ryvfs"`). */
export function ryvfsBin(): string {
    const configured = process.env.PI_POCKET_RYVFS_BIN?.trim();

    if (configured) {
        return configured;
    }

    const local = join(homedir(), ".local", "bin", "ryvfs");

    return existsSync(local) ? local : "ryvfs";
}

export async function runCli(
    bin: string,
    args: readonly string[],
    options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BUFFER,
        encoding: "utf8",
    });

    return { stdout, stderr };
}

function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/**
 * Attempt to create a zero-disk RyvFS composite worktree when `cwd` belongs to a `workspace.kdl` checkout whose
 * RyvFS stores are initialized. Returns `undefined` when no workspace manifest applies or stores are not yet
 * initialized (allowing Git repositories to fall back to `git worktree`).
 */
export async function tryCreateRyvfsWorktree(
    cwd: string,
    folder: string,
    label: string,
): Promise<{ worktree: WorktreeShape; cwd: string; skipped: string[] } | undefined> {
    const wsFile = baarkWorkspaceFileOf(cwd);

    if (wsFile === undefined) {
        return undefined;
    }

    const ruttr = ruttrBin();
    let which: WhichInfo;

    try {
        const { stdout } = await runCli(ruttr, [
            "workspace",
            "which",
            cwd,
            "--file",
            wsFile,
            "--json",
        ]);

        which = JSON.parse(stdout) as WhichInfo;
    } catch {
        return undefined;
    }

    const repo = which.repo?.trim() || undefined;
    const checkout = which.checkout?.trim() || undefined;

    if (repo === undefined || checkout === undefined) {
        return undefined;
    }

    const slug =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "session";
    const name = `${slug}-${randomUUID().slice(0, 6)}`;
    const forkDir = join(folder, name);
    const ryvfs = ryvfsBin();

    mkdirSync(folder, { recursive: true });

    let openOut: OpenContext;

    try {
        const { stdout } = await runCli(ruttr, [
            "workspace",
            "open",
            repo,
            "--file",
            wsFile,
            "--fork",
            forkDir,
            "--ryvfs",
            ryvfs,
            "--agent",
            `pocket-${name}`,
            "--json",
        ]);

        openOut = JSON.parse(stdout) as OpenContext;
    } catch (error) {
        rmSync(`${forkDir}.manifest.json`, { force: true });
        rmSync(forkDir, { recursive: true, force: true });

        // Fall back to Git worktrees when stores are uninitialized, unless this folder has Pijul without Git.
        if (pijulDirOf(cwd) !== undefined && gitDirOf(cwd) === undefined) {
            throw new HttpError(
                500,
                `The RyvFS composite worktree could not be created: ${describe(error)}`,
            );
        }

        return undefined;
    }

    if (openOut.composite?.forked !== true) {
        rmSync(`${forkDir}.manifest.json`, { force: true });

        return undefined;
    }

    const sidecar: RyvfsSidecar = {
        kind: "ryvfs-compose",
        repo,
        sourceCheckout: checkout,
        workspaceFile: wsFile,
    };

    // Stored beside the composite rather than inside it so `ryvfs compose fork-rm` never sees stray files outside mounts.
    writeFileSync(`${forkDir}.pocket.json`, `${JSON.stringify(sidecar, null, 2)}\n`);

    const within = relative(real(checkout), real(cwd));
    const repoMount = join(forkDir, repo);
    const targetCwd =
        within === "" || within.startsWith("..") || within.startsWith(`..${sep}`)
            ? repoMount
            : resolve(repoMount, within);

    return {
        worktree: {
            path: forkDir,
            branch: `ryvfs/${name}`,
            source: cwd,
        },
        cwd: targetCwd,
        skipped: [],
    };
}

/** Whether `worktree` is backed by a RyvFS composite fork rather than `git worktree`. */
export function isRyvfsWorktree(worktree: Pick<WorktreeShape, "path" | "branch">): boolean {
    return (
        worktree.branch.startsWith("ryvfs/") ||
        existsSync(`${worktree.path}.pocket.json`) ||
        existsSync(`${worktree.path}.manifest.json`)
    );
}

/** Remove a RyvFS composite worktree via `ryvfs compose fork-rm`, guarding uncommitted edits unless `force`. */
export async function removeRyvfsWorktree(worktree: WorktreeShape, force: boolean): Promise<void> {
    if (!existsSync(worktree.path)) {
        rmSync(`${worktree.path}.manifest.json`, { force: true });
        rmSync(`${worktree.path}.pocket.json`, { force: true });

        return;
    }

    const ryvfs = ryvfsBin();

    if (!force) {
        try {
            const { stdout } = await runCli(ryvfs, ["compose", "scan", worktree.path]);

            if (/,\s*[1-9]\d*\s+(?:changed|deleted)/.test(stdout)) {
                throw new HttpError(409, "The worktree has uncommitted changes.");
            }
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(500, `The worktree could not be checked: ${describe(error)}`);
        }
    }

    try {
        await runCli(ryvfs, ["compose", "fork-rm", worktree.path]);
    } catch (error) {
        throw new HttpError(500, `The worktree could not be removed: ${describe(error)}`);
    }

    rmSync(`${worktree.path}.manifest.json`, { force: true });
    rmSync(`${worktree.path}.pocket.json`, { force: true });
}

/** Map a subfolder inside a RyvFS composite worktree back to its matching checkout folder. */
export function sourceRyvfsFolders(worktree: WorktreeShape): (cwd: string) => string {
    let sidecar: RyvfsSidecar | undefined;

    try {
        sidecar = JSON.parse(readFileSync(`${worktree.path}.pocket.json`, "utf8")) as RyvfsSidecar;
    } catch {
        sidecar = undefined;
    }

    const original = (() => {
        try {
            return realpathSync(worktree.source);
        } catch {
            return undefined;
        }
    })();

    return (cwd: string) => {
        if (sidecar === undefined) {
            return worktree.source;
        }

        const rel = relative(join(worktree.path, sidecar.repo), cwd);

        if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
            return worktree.source;
        }

        const mapped = resolve(sidecar.sourceCheckout, rel);

        return mapped === original || !existsSync(mapped) ? worktree.source : mapped;
    };
}
