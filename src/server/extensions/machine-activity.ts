/** Inspect which conversations own running commands and cooperative locks on a worker. */
import { obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

export default function machineActivity(host: PocketHost) {
    const tool = defineTool({
        name: "machine_activity",
        description:
            "Read current process and cooperative lock ownership across permitted conversations on a machine. Use when builds, GPU work or machine pressure block progress. This does not stop processes or release locks. Unavailable measurements and unattributed work are explicit.",
        replay: "safe",
        parameters: obj({
            machineId: opt(
                str({
                    description: "Worker ID; omitted means this conversation's machine.",
                }),
            ),
        }),
        execute: async (args, api) => {
            if (host.machineActivity === undefined) {
                throw new Error("Machine activity is unavailable on this server");
            }

            const result = await host.machineActivity(api.conversationId, args.machineId);

            return { output: [{ type: "text" as const, text: JSON.stringify(result) }] };
        },
    });

    return defineExtension({
        name: "pocket-machine-activity",
        tools: [tool],
        sections: [
            section(
                "machine_activity",
                () =>
                    "When a build, GPU lock or machine pressure blocks you, call machine_activity before launching competing work. Command processes carry POCKET_INSTANCE_ID, POCKET_CONVERSATION_ID, POCKET_EXECUTION_ID and (for tool calls) POCKET_TOOL_CALL_ID. Inspect the owning conversation and reuse existing results where useful. Never infer permission to kill another session's process or delete a lock from this diagnostic. Cooperative locks can be acquired with the worker's activity-run.mjs --lock RESOURCE -- PROGRAM ARGS; machine_activity reports the launcher paths. Existing unmanaged locks may be unattributed.",
            ),
        ],
    });
}
