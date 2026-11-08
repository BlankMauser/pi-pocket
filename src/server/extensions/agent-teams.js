// Agent Teams' browser module: how calls of its team tool show, in a line in transcripts and peek tiles, and in
// the summary of a group of calls. It only describes; it adds no routes.
export const pocketApi = 1;

const LABELS = {
    start: "start session",
    send: "message session",
    list: "list sessions",
    stop: "stop session",
    archive: "archive session",
};

const text = (value) => (typeof value === "string" ? value : "");

export default function setup(pocket) {
    pocket.toolCall({
        tool: "team",
        icon: "fork",
        label: (args) =>
            args.action === "archive" && args.archived === false
                ? "restore session"
                : (LABELS[args.action] ?? "linked sessions"),
        subject: (args) =>
            [args.action === "start" ? text(args.title) : text(args.to), text(args.message)]
                .filter((part) => part !== "")
                .join(" · "),
        summary: (args) =>
            args.action === "start"
                ? { verb: "started", noun: "session" }
                : args.action === "send"
                  ? { verb: "messaged", noun: "session", by: "to" }
                  : args.action === "stop"
                    ? { verb: "stopped", noun: "session" }
                    : args.action === "archive"
                      ? { verb: args.archived === false ? "restored" : "archived", noun: "session" }
                      : { verb: "checked linked sessions" },
    });
}
