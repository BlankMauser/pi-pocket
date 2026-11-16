/**
 * Baark multi-repository workspace and Archil cloud-build integration (`ruttr workspace` + `ryvfs`). Active prompt
 * guidance and guardrails apply only when a session works in a folder with `workspace.kdl`, `.pijul`, or a RyvFS
 * composite fork.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { num, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
    AgentDoc,
    defineExtension,
    defineTool,
    hook,
    section,
    ToolTask,
} from "@earendil-works/pi-durable";
import {
    baarkWorkspaceFileOf,
    pijulDirOf,
    runCli,
    ruttrBin,
    ryvfsBin,
    ryvfsComposeDirOf,
} from "../baark-ryvfs.ts";
import { describe } from "../errors.ts";
import type { PocketHost } from "../host.ts";
import { literal } from "../tool-schema.ts";

const EXTENSION_NAME = "pocket-ruttr-workspace";
const OUTPUT_LIMIT = 12_000;
const RAW_GIT_PUSH = /(?:^|[;&|()]\s*)git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+push(?:\s|$)/;

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

function clipOutput(text: string): string {
    const trimmed = text.trim();

    if (trimmed.length <= OUTPUT_LIMIT) {
        return trimmed || "(no output)";
    }

    return `${trimmed.slice(0, OUTPUT_LIMIT - 20)}\n...[truncated]`;
}

function readCompositeWorkspace(composeDir: string): string | undefined {
    try {
        const raw = JSON.parse(readFileSync(join(composeDir, "composite.json"), "utf8")) as {
            workspace?: unknown;
        };

        return typeof raw.workspace === "string" && raw.workspace.trim() !== ""
            ? raw.workspace.trim()
            : undefined;
    } catch {
        return undefined;
    }
}

export default function createRuttrWorkspace(host: PocketHost) {
    const archilBuild = defineTool({
        name: "archil_build",
        description:
            'Run heavy Cargo/MoonBit builds or test suites remotely on an Archil cloud route (via `ryvfs job submit --on <cloud>`) or locally in a RyvFS composite mount namespace (`cloud: "local"`) so local disks do not fill up.',
        parameters: obj(
            {
                command: str({ description: "Shell command to execute on the build runner." }),
                cloud: opt(
                    str({
                        description:
                            'Cloud/box route name (default "arc", or "local" to run under `ryvfs compose run`).',
                    }),
                ),
                ws: opt(
                    str({
                        description:
                            "Optional RyvFS workspace name (auto-detected from composite.json when omitted).",
                    }),
                ),
                cpus: opt(num({ description: "Optional vCPU count for the remote instance." })),
                mem: opt(str({ description: "Optional memory limit (e.g. 16G)." })),
            },
            { open: true },
        ),
        replay: "unsafe",
        execute: async (args, api, context) => {
            const agent = await api.snapshot(AgentDoc, api.conversationId, context);
            const cwd = agent?.cwd ?? process.cwd();
            const ryvfs = ryvfsBin();
            const route = args.cloud?.trim() || process.env.PI_POCKET_ARCHIL_CLOUD?.trim() || "arc";

            if (route === "local") {
                const composeDir = ryvfsComposeDirOf(cwd) ?? cwd;

                try {
                    const { stdout, stderr } = await runCli(
                        ryvfs,
                        ["compose", "run", composeDir, "--", "bash", "-lc", args.command],
                        { cwd, timeoutMs: 300_000 },
                    );

                    return reply(clipOutput([stdout, stderr].filter(Boolean).join("\n")));
                } catch (error) {
                    throw new Error(`archil_build local run failed: ${describe(error)}`);
                }
            }

            const composeDir = ryvfsComposeDirOf(cwd);
            const ws =
                args.ws?.trim() ||
                (composeDir ? readCompositeWorkspace(composeDir) : undefined) ||
                process.env.RYVFS_WS?.trim() ||
                undefined;
            const submitArgs = [
                "job",
                "submit",
                "--on",
                route,
                ...(ws === undefined ? [] : ["--ws", ws]),
                ...(typeof args.cpus === "number" ? ["--cpus", String(args.cpus)] : []),
                ...(args.mem?.trim() ? ["--mem", args.mem.trim()] : []),
                "--json",
                "--",
                "bash",
                "-lc",
                args.command,
            ];

            let jobId: string | undefined;

            try {
                const { stdout } = await runCli(ryvfs, submitArgs, { cwd, timeoutMs: 120_000 });
                const parsed = JSON.parse(stdout) as { id?: string | number };

                jobId = parsed.id === undefined ? undefined : String(parsed.id);
            } catch (error) {
                throw new Error(`archil_build submit failed: ${describe(error)}`);
            }

            if (jobId === undefined) {
                throw new Error("archil_build submit returned no job id.");
            }

            try {
                const waitRes = await runCli(ryvfs, ["job", "wait", jobId], {
                    cwd,
                    timeoutMs: 600_000,
                });
                const logRes = await runCli(ryvfs, ["job", "log", jobId, "--tail", "120"], {
                    cwd,
                    timeoutMs: 30_000,
                }).catch(() => ({ stdout: "", stderr: "" }));

                return reply(
                    clipOutput(
                        [waitRes.stdout.trim(), logRes.stdout.trim()].filter(Boolean).join("\n\n"),
                    ),
                );
            } catch (error) {
                const logRes = await runCli(ryvfs, ["job", "log", jobId, "--tail", "120"], {
                    cwd,
                    timeoutMs: 30_000,
                }).catch(() => ({ stdout: "", stderr: "" }));
                const tail = logRes.stdout.trim();

                throw new Error(
                    `archil_build job ${jobId} failed: ${describe(error)}${tail ? `\n${tail}` : ""}`,
                );
            }
        },
    });

    const ryvfsFork = defineTool({
        name: "ryvfs_fork",
        description:
            "Manage zero-disk RyvFS multi-repository composite forks from workspace.kdl (`open` creates an isolated composite fork under dataDir/worktrees, `status` inspects pins, `remove` deletes a fork).",
        parameters: obj(
            {
                action: union([literal("open"), literal("status"), literal("remove")]),
                repo: opt(str({ description: "open/status: repository name from workspace.kdl." })),
                dir: opt(str({ description: "open/remove: composite directory path." })),
                label: opt(str({ description: "open: fork name/agent label." })),
            },
            { open: true },
        ),
        replay: "unsafe",
        execute: async (args, api, context) => {
            const agent = await api.snapshot(AgentDoc, api.conversationId, context);
            const cwd = agent?.cwd ?? process.cwd();
            const ruttr = ruttrBin();
            const ryvfs = ryvfsBin();

            if (args.action === "remove") {
                const dir = args.dir?.trim();

                if (!dir) {
                    throw new Error("ryvfs_fork remove requires `dir`.");
                }

                const target = resolve(cwd, dir);

                if (existsSync(target)) {
                    await runCli(ryvfs, ["compose", "fork-rm", target], { cwd });
                }

                rmSync(`${target}.manifest.json`, { force: true });
                rmSync(`${target}.pocket.json`, { force: true });

                return reply(`Removed RyvFS composite fork at ${target}.`);
            }

            const wsFile = baarkWorkspaceFileOf(cwd);

            if (wsFile === undefined) {
                return reply("No workspace.kdl manifest found in this folder or its parents.");
            }

            if (args.action === "status") {
                const { stdout } = await runCli(
                    ruttr,
                    [
                        "workspace",
                        "status",
                        ...(args.repo?.trim() ? [args.repo.trim()] : []),
                        "--file",
                        wsFile,
                    ],
                    { cwd },
                );

                return reply(clipOutput(stdout));
            }

            const repo = args.repo?.trim();

            if (!repo) {
                throw new Error("ryvfs_fork open requires `repo`.");
            }

            const rawLabel = (args.label?.trim() || `${repo}-fork`)
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "-")
                .replace(/^-+|-+$/g, "");
            const label = rawLabel || "fork";
            const targetDir = args.dir?.trim()
                ? resolve(cwd, args.dir.trim())
                : join(host.dataDir, "worktrees", `${label}-${Date.now().toString(36)}`);
            const { stdout } = await runCli(
                ruttr,
                [
                    "workspace",
                    "open",
                    repo,
                    "--file",
                    wsFile,
                    "--fork",
                    targetDir,
                    "--ryvfs",
                    ryvfs,
                    "--agent",
                    label,
                    "--json",
                ],
                { cwd },
            );

            return reply(clipOutput(stdout));
        },
    });

    return defineExtension({
        name: EXTENSION_NAME,
        tools: [archilBuild, ryvfsFork],
        sections: [
            section("baark-workspace", ({ agent }) => {
                const cwd = agent.cwd ?? process.cwd();
                const hasWs = baarkWorkspaceFileOf(cwd) !== undefined;
                const hasPijul = pijulDirOf(cwd) !== undefined;
                const hasCompose = ryvfsComposeDirOf(cwd) !== undefined;

                if (!hasWs && !hasPijul && !hasCompose) {
                    return undefined;
                }

                return [
                    "This workspace uses Baark (`workspace.kdl` / Pijul / RyvFS composite forks):",
                    "- Use `ryvfs_fork` when spinning up parallel multi-repo sandboxes instead of duplicating full checkouts on disk.",
                    "- Use `archil_build` for heavy Cargo/MoonBit builds instead of filling local `/home` or `/mnt/data` caches.",
                    "- Canonical history lives in Pijul / Baark (`ruttr`); never use raw `git push` on canonical Pijul repositories.",
                ].join("\n");
            }),
        ],
        hooks: [
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if (call.name !== "bash") {
                        return undefined;
                    }

                    const command =
                        typeof call.arguments.command === "string" ? call.arguments.command : "";

                    if (!RAW_GIT_PUSH.test(command)) {
                        return undefined;
                    }

                    const agent = await api.snapshot(AgentDoc, api.conversationId, context);
                    const cwd = agent?.cwd ?? process.cwd();

                    if (pijulDirOf(cwd) !== undefined) {
                        return {
                            block: "This folder uses canonical Pijul (.pijul): raw `git push` is blocked. Submit or push changes through `ruttr` instead.",
                        };
                    }

                    return undefined;
                },
            }),
        ],
    });
}
