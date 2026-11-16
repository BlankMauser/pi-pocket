// Baark workspace integration: zero-disk RyvFS composite worktrees, native Pijul metadata/guards,
// Archil cloud build tool (`archil_build`), and durable `baark_watch` feed/workflow notifications.
import {
    type App,
    cleanUp,
    lastText,
    loadTools,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BAARK_EVENT_CLOSE, BAARK_EVENT_OPEN } from "../src/server/baark-watches.ts";

const binDir = join(root, "mock-bin");
const mockRuttr = join(binDir, "ruttr");
const mockRyvfs = join(binDir, "ryvfs");
const mockLog = join(root, "mock-calls.log");
const mockState = {
    forked: true,
    dirtyScan: false,
    jobLog: "archil build passed: 12 tests ok",
};
const stateFile = join(root, "mock-state.json");

const wsDir = join(root, "baark-ws");
const repoDir = join(wsDir, "checkouts", "alpha");
const hybridDir = join(root, "hybrid-ws");
const hybridRepo = join(hybridDir, "checkouts", "beta");

let nodeServer: Server;
let nodeUrl = "";
const nodeFeed = [{ sequence: 7, kind: "accept", author: "alice", summary: "Landing group #7" }];
const nodeRuns = [
    {
        id: "wf-99",
        trigger: "cron",
        schedule_id: "nightly",
        status: "succeeded",
        dex_slug: "nightly-docs",
    },
];
const deliveredPrompts: string[] = [];

const route: FauxResponseStep = (request) => {
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (role === "user") {
        deliveredPrompts.push(text);
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool: ${text}`)]);
    }

    if (text.startsWith("call ")) {
        const { tool, ...args } = JSON.parse(text.slice("call ".length)) as { tool: string };

        return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(`ok: ${text.slice(0, 40)}`)]);
};

let app: App;
const prevRuttr = process.env.PI_POCKET_RUTTR_BIN;
const prevRyvfs = process.env.PI_POCKET_RYVFS_BIN;

function syncMockState(): void {
    writeFileSync(stateFile, JSON.stringify(mockState));
}

before(async () => {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoDir, ".pijul"), { recursive: true });
    mkdirSync(join(repoDir, "sub"), { recursive: true });
    writeFileSync(join(wsDir, "workspace.kdl"), 'workspace "demo"\n');
    writeFileSync(join(repoDir, ".pijul", "config"), 'current_channel = "main"\n');
    writeFileSync(join(repoDir, "sub", "lib.rs"), "pub fn ok() {}\n");

    mkdirSync(hybridRepo, { recursive: true });
    writeFileSync(join(hybridDir, "workspace.kdl"), 'workspace "hybrid"\n');
    execFileSync("git", ["init", "-q"], { cwd: hybridRepo });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: hybridRepo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: hybridRepo });
    writeFileSync(join(hybridRepo, "README.md"), "hybrid\n");
    execFileSync("git", ["add", "-A"], { cwd: hybridRepo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: hybridRepo });

    syncMockState();

    // Cross-platform scriptable mocks implemented with Node so CLI args and composite trees match `ruttr`/`ryvfs`.
    writeFileSync(
        mockRuttr,
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(mockLog)}, "ruttr " + JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (args[0] === "workspace" && args[1] === "which") {
  const cwd = args[2];
  const isHybrid = cwd.startsWith(${JSON.stringify(hybridDir)});
  console.log(JSON.stringify({
    workspace: isHybrid ? "hybrid" : "demo",
    repo: isHybrid ? "beta" : "alpha",
    checkout: isHybrid ? ${JSON.stringify(hybridRepo)} : ${JSON.stringify(repoDir)},
  }));
} else if (args[0] === "workspace" && args[1] === "status") {
  console.log("status: alpha clean (main)");
} else if (args[0] === "workspace" && args[1] === "open") {
  const repo = args[2];
  const forkIdx = args.indexOf("--fork");
  const forkDir = forkIdx >= 0 ? args[forkIdx + 1] : undefined;
  const isHybrid = (args[args.indexOf("--file") + 1] || "").startsWith(${JSON.stringify(hybridDir)});
  const forked = !isHybrid && state.forked;
  if (forked && forkDir) {
    fs.mkdirSync(path.join(forkDir, repo, ".pijul"), { recursive: true });
    fs.mkdirSync(path.join(forkDir, repo, "sub"), { recursive: true });
    fs.writeFileSync(path.join(forkDir, "composite.json"), JSON.stringify({ workspace: "ws-" + repo }));
    fs.writeFileSync(forkDir + ".manifest.json", "{}");
    fs.writeFileSync(path.join(forkDir, repo, ".pijul", "config"), 'current_channel = "main"\\n');
    fs.writeFileSync(path.join(forkDir, repo, "sub", "lib.rs"), "pub fn ok() {}\\n");
  }
  console.log(JSON.stringify({ composite: { forked } }));
}
`,
    );
    chmodSync(mockRuttr, 0o755);

    writeFileSync(
        mockRyvfs,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(mockLog)}, "ryvfs " + JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (args[0] === "compose" && args[1] === "scan") {
  console.log(state.dirtyScan ? "alpha: 1 files, 1 changed, 0 deleted" : "alpha: 1 files, 0 changed, 0 deleted");
} else if (args[0] === "compose" && args[1] === "fork-rm") {
  fs.rmSync(args[2], { recursive: true, force: true });
} else if (args[0] === "job" && args[1] === "submit") {
  console.log(JSON.stringify({ id: 42 }));
} else if (args[0] === "job" && args[1] === "wait") {
  console.log("job 42 done (exit 0)");
} else if (args[0] === "job" && args[1] === "log") {
  console.log(state.jobLog);
} else if (args[0] === "compose" && args[1] === "run") {
  console.log("local compose run ok");
}
`,
    );
    chmodSync(mockRyvfs, 0o755);

    process.env.PI_POCKET_RUTTR_BIN = mockRuttr;
    process.env.PI_POCKET_RYVFS_BIN = mockRyvfs;

    nodeServer = createServer((req, res) => {
        if (req.url === "/v1/repositories/demo/feed") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(nodeFeed));

            return;
        }

        if (req.url === "/v1/repositories/demo/workflows") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ runs: nodeRuns }));

            return;
        }

        res.statusCode = 404;
        res.end("{}");
    });
    await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));
    const addr = nodeServer.address();

    assert.ok(addr && typeof addr === "object");
    nodeUrl = `http://127.0.0.1:${addr.port}`;

    app = await openApp(scriptedModel(route), join(root, "baark-ws-data"));
    app.baarkWatches.timing = { poll: 40, soon: 20, retry: 40 };
});

after(async () => {
    await app?.close();
    await new Promise<void>((resolve) => nodeServer.close(() => resolve()));

    if (prevRuttr === undefined) {
        delete process.env.PI_POCKET_RUTTR_BIN;
    } else {
        process.env.PI_POCKET_RUTTR_BIN = prevRuttr;
    }

    if (prevRyvfs === undefined) {
        delete process.env.PI_POCKET_RYVFS_BIN;
    } else {
        process.env.PI_POCKET_RYVFS_BIN = prevRyvfs;
    }

    cleanUp();
});

test("workspace.kdl + Pijul sessions create zero-disk RyvFS composite worktrees and fall back to Git when uninitialized", async () => {
    const subCwd = join(repoDir, "sub");
    const { id } = await app.commands.createSession(owner(app), {
        cwd: subCwd,
        title: "Agent Alpha",
        worktree: true,
    });

    assert.equal(app.workspace.inRepository(subCwd), true);
    assert.deepEqual(app.workspace.head(id), { branch: "main" });

    const worktree = app.sessionMeta(id)!.worktree!;

    assert.match(worktree.branch, /^ryvfs\/agent-alpha-[0-9a-f]{6}$/);
    assert.equal(app.cwdOf(id), join(worktree.path, "alpha", "sub"));
    assert.equal(existsSync(`${worktree.path}.pocket.json`), true);

    mockState.dirtyScan = true;
    syncMockState();
    await assert.rejects(app.commands.removeWorktree(id, owner(app), false), { status: 409 });

    await app.commands.removeWorktree(id, owner(app), true);
    assert.equal(existsSync(worktree.path), false);
    assert.equal(existsSync(`${worktree.path}.pocket.json`), false);
    assert.equal(app.cwdOf(id), subCwd);

    // Hybrid git + workspace.kdl falls back cleanly to a git worktree when RyvFS returns forked:false.
    const { id: gitFallbackId } = await app.commands.createSession(owner(app), {
        cwd: hybridRepo,
        title: "Hybrid Git",
        worktree: true,
    });
    const fallbackWt = app.sessionMeta(gitFallbackId)!.worktree!;

    assert.match(fallbackWt.branch, /^pocket\/hybrid-git-[0-9a-f]{6}$/);
    await app.commands.removeWorktree(gitFallbackId, owner(app), true);
    assert.equal(existsSync(fallbackWt.path), false);
});

test("ruttr-workspace extension guards raw git push in Pijul and runs archil_build + ryvfs_fork", async () => {
    const id = await newSession(app, join(repoDir, "sub"));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    await loadTools(app, id, "archil_build", "ryvfs_fork");

    await say(app, id, `call ${JSON.stringify({ tool: "bash", command: "git push origin main" })}`);
    await say(
        app,
        id,
        `call ${JSON.stringify({ tool: "archil_build", cloud: "arc", ws: "ws-alpha", command: "cargo test" })}`,
    );
    await say(
        app,
        id,
        `call ${JSON.stringify({ tool: "ryvfs_fork", action: "status", repo: "alpha" })}`,
    );

    const history = (await modelTexts(app, id)).join("\n");

    assert.match(history, /canonical Pijul/i);
    assert.match(history, /archil build passed/);
    assert.match(history, /alpha clean/);

    const calls = readFileSync(mockLog, "utf8");

    assert.match(calls, /"job","submit","--on","arc"/);
    assert.match(calls, /"workspace","status","alpha"/);
});

test("baark_watch polls Baark feed & workflows, fences <baark-event>, and deduplicates", async () => {
    const id = await newSession(app, join(repoDir, "sub"));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
    });
    await loadTools(app, id, "baark_watch");

    await say(
        app,
        id,
        `call ${JSON.stringify({
            tool: "baark_watch",
            action: "start",
            nodeUrl,
            repo: "demo",
            instructions: "Report landed changes.",
        })}`,
    );
    const afterStart = (await modelTexts(app, id)).join("\n");

    assert.match(afterStart, /Watching Baark repository demo/);

    await until(
        () =>
            deliveredPrompts.some(
                (p) =>
                    p.includes(BAARK_EVENT_OPEN) &&
                    p.includes(BAARK_EVENT_CLOSE) &&
                    p.includes("Feed #7") &&
                    p.includes("wf-99"),
            ),
        "baark_watch to deliver feed and workflow events",
    );

    await say(app, id, `call ${JSON.stringify({ tool: "baark_watch", action: "list" })}`);
    const afterList = await modelTexts(app, id);
    const listReply =
        afterList.findLast((entry) => entry.includes("demo at http://127.0.0.1:")) ?? "";
    const match = /([0-9a-f]{6}): demo at http:\/\/127\.0\.0\.1:/.exec(listReply);

    assert.ok(match !== null, `expected listed watch id in ${listReply}`);

    const countBefore = deliveredPrompts.filter((p) => p.includes("Feed #7")).length;

    await new Promise((resolve) => setTimeout(resolve, 120));
    const countAfter = deliveredPrompts.filter((p) => p.includes("Feed #7")).length;

    assert.equal(countAfter, countBefore, "seen events are not re-delivered");

    await say(
        app,
        id,
        `call ${JSON.stringify({ tool: "baark_watch", action: "stop", id: match[1]! })}`,
    );
    const afterStop = (await modelTexts(app, id)).join("\n");

    assert.match(afterStop, /Stopped Baark watch/);
});
