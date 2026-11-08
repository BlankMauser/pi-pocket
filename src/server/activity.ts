/** Per-command attribution stays local to each invocation, including concurrent tools. */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ToolRegistration } from "@earendil-works/pi-durable";

export function activityInstance(dataDir: string): string {
    const path = join(dataDir, "activity-instance-id");

    try {
        writeFileSync(path, randomUUID(), { flag: "wx", mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    }

    const id = readFileSync(path, "utf8").trim();

    if (!/^[a-f0-9-]{36}$/.test(id)) {
        throw new Error("Invalid activity instance identity");
    }

    return id;
}

function replaceExec(base: ExecutionEnv, exec: ExecutionEnv["exec"]): ExecutionEnv {
    return new Proxy(base, {
        get(target, key) {
            if (key === "exec") {
                return exec;
            }

            const value = Reflect.get(target, key, target) as unknown;

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export function attributedTool<T extends ToolRegistration>(tool: T): T {
    return {
        ...tool,
        execute: (args, api, context) => {
            const base = api.env;
            const env =
                base === undefined
                    ? undefined
                    : replaceExec(base, (command, options, ctx) =>
                          base.exec(
                              command,
                              {
                                  ...options,
                                  env: { ...options?.env, POCKET_TOOL_CALL_ID: api.callId },
                              },
                              ctx,
                          ),
                      );

            return tool.execute(args, { ...api, env }, context);
        },
    };
}

export function attributedEnv(
    base: ExecutionEnv,
    identity: Record<string, string>,
    capabilities: () => Promise<{ node: string; runner: string }>,
): ExecutionEnv {
    return replaceExec(base, async (command, options, context) => {
        const paths = await capabilities();
        // pi-env uses Bash on Unix and Git Bash on Windows. Only trusted paths
        // are shell-quoted; the original command travels as an environment value.
        const quote = (value: string) =>
            "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";

        return base.exec(
            `${quote(paths.node)} ${quote(paths.runner)}`,
            {
                ...options,
                env: {
                    ...options?.env,
                    ...identity,
                    POCKET_EXECUTION_ID: randomUUID(),
                    POCKET_ACTIVITY_COMMAND: JSON.stringify(command),
                },
            },
            context,
        );
    });
}
