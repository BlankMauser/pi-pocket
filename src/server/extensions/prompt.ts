/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PromptInput } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";
import { workspaceScheme } from "../paths.ts";
import { openAiFastPrompt } from "../fast-mode-status.ts";
import { codingAgentSdk, durableSdk } from "../runtime-sdk.ts";
import { machinePath } from "../workers.ts";
import { formatSkills } from "../prompts.ts";

export { formatSkills };

const { getDocsPath, loadProjectContextFiles } = codingAgentSdk;
const { defineExtension, section } = durableSdk;

const PREAMBLE = `You are Pi, a coding agent in Pi Pocket, a durable, multiplayer web app. People talk to you from a browser, often a phone, and several can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory. Your work is durable: after a server restart, you continue where you left off. A tool call cut off by a restart that was not safe to repeat comes back as "interrupted": check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Look at files with read, not cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly.
- Before you say work is done, check it: run its tests, build, or app, and read the result. Say plainly what you did not check; never claim a check you did not run.
- To show an image file from this machine, embed it: ![short description](/absolute/or/relative/path.png). Files the user attaches are saved on the server; the message lists their paths.
- Before something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- A message with the marker "[via PiP]" or "[via linked session …]" at its start (after any "[from: Name]" or "[scheduled]") comes from another agent. Write your answer to it, and what you send back to that agent, in the language that agent wrote in (for a linked session, the text between the <linked-session-message> tags), not the language of the marker or the notes around it. In English, use ASD-STE100 (Simplified Technical English) at about 80% adherence: short sentences (25 words or fewer), one idea each, main point first, active voice, simple tenses, articles kept, no contractions or idioms, "must" for a rule and "can" for an ability, numerals, one word for one thing, names of commands, files, and identifiers exact in backticks, every fact kept. In another language, keep the same short, plain style. Answer messages without the marker as usual, also later in the same session.`;

/**
 * Where Pi Pocket's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pi Pocket's docs, only for questions about Pi Pocket itself (how it works, your behavior in it, extending or changing it): start at the index ${join(folder, "index.md")}, follow only the links your task needs, and read a doc completely before changing anything.
- Code: ${code}${code.split(sep).includes("node_modules") ? " (an npm install: read it, never edit it, since the next npm update replaces it; to change Pi Pocket, clone https://github.com/TannerMidd/pi-pocket and run that)" : ""}. Data: ${dataDir}; change it through the app, never by editing its files, except extensions/ (drop-ins) and themes/.
- Pi's own docs (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    context: string | undefined;
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or Pi's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, Pi's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads Pi's settings again in the background as often).
    const resources = new Map<string, Resources>();

    const trustChanged = () => {
        try {
            return statSync(join(host.agentDir, "trust.json")).mtimeMs;
        } catch {
            return 0;
        }
    };

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);
        const trust = trustChanged();

        if (cached !== undefined && Date.now() - cached.at < STALE_MS && cached.trust === trust) {
            return cached;
        }

        let context: string | undefined;
        let skills: string | undefined;

        try {
            const files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });

            if (files.length > 0) {
                context = files
                    .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                    .join("\n\n");
            }
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const text = formatSkills(host.skills(cwd));

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), trust, context, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    const cwdOf = (input: PromptInput) => input.env?.cwd ?? input.agent.cwd ?? process.cwd();
    // A workspace URI (`ssh://…`): this machine's AGENTS.md files and skills are not the remote's.

    const remote = (input: PromptInput) => {
        const cwd = input.agent.cwd ?? "";

        return machinePath(cwd) === undefined ? undefined : cwd;
    };

    return defineExtension({
        name: "pocket-prompt",
        sections: [
            section("preamble", () => PREAMBLE, { tag: false }),
            section("guidelines", () => GUIDELINES),
            section("openai_fast", () => openAiFastPrompt(host.dataDir)),
            section("pocket_docs", () => docs(host.dataDir)),
            section("project_context", async (input) => {
                const cwd = remote(input);

                return cwd === undefined
                    ? workspaceScheme(input.agent.cwd ?? "") === undefined
                        ? load(cwdOf(input)).context
                        : undefined
                    : (await host.workers!.resources(cwd)).context;
            }),
            section(
                "skills",
                async (input) => {
                    const cwd = remote(input);

                    return cwd === undefined
                        ? workspaceScheme(input.agent.cwd ?? "") === undefined
                            ? load(cwdOf(input)).skills
                            : undefined
                        : (await host.workers!.resources(cwd)).skills;
                },
                { tag: false },
            ),
            section("environment", async (input) => {
                const cwd = remote(input);
                const platform =
                    cwd === undefined
                        ? process.platform
                        : (await host.workers!.resources(cwd)).platform;
                const machine =
                    cwd === undefined
                        ? ""
                        : `\nExecution machine: ${machinePath(cwd)!.machineId}. Files and commands run there; do not use mm:// identifiers in tool paths.`;
                const base = `Working directory: ${cwdOf(input)}${machine}\nPlatform: ${platform}`;

                // On by default in this build (upstream leaves it off, as a date rewrites the prompt cache once a day).
                // PI_POCKET_PROMPT_DATE=0 leaves the local date out.
                if (process.env.PI_POCKET_PROMPT_DATE === "0") {
                    return base;
                }

                const now = new Date();
                const pad = (n: number) => String(n).padStart(2, "0");

                return `${base}\nToday: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            }),
        ],
    });
}
