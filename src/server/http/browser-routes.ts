/** `/api/c/:id/browser`: the Browser panel. */
import type { ConversationId } from "@earendil-works/pi-durable";
import { BrowserError } from "../browser/cdp.ts";
import { localServers } from "../browser/local-servers.ts";
import { displayUrl, normalizeUrl } from "../browser/urls.ts";
import { viewportFrom } from "../browser/viewport.ts";
import { HttpError } from "../errors.ts";
import { machinePath } from "../workers.ts";
import { type ApiRequest, json, readJson } from "./io.ts";

/** What people may do to a conversation's browser page. */
const BROWSER_ACTIONS = new Set([
    "open",
    "navigate",
    "back",
    "forward",
    "reload",
    "stop",
    "viewport",
    "input",
    "clear",
]);

/** The browser's own failures (none installed, it crashed) are the person's to read, not a server error. */
function readable(error: unknown): never {
    if (error instanceof BrowserError) {
        throw new HttpError(409, error.message);
    }

    throw error;
}

/**
 * The Browser panel: the conversation's page as frames, its console, and what people do to it. Everyone who can see
 * the conversation watches; using the page takes what steering Pi takes, as the browser reaches what this machine
 * reaches. The addresses people open show in the chat. Only the owner opens files on this machine from the address
 * bar (Pi opens them with its own tool), and only the owner gets the list of servers running here.
 */
export async function browserRoutes(
    api: ApiRequest,
    id: ConversationId,
    action: string | undefined,
    port: number,
): Promise<void> {
    const { app, request, response, url, user } = api;
    const method = request.method ?? "GET";

    if (!app.browserOn()) {
        throw new HttpError(404, "The browser is off. The owner turns it on in Extensions.");
    }

    if (machinePath(app.cwdOf(id)) !== undefined) {
        return remoteRoutes(api, id, action, port);
    }

    const browsers = app.browsers;
    const key = Number(id);

    if (action === undefined && method === "GET") {
        return json(response, 200, browsers.state(key));
    }

    if (action === "frame" && method === "GET") {
        const page = browsers.page(key);

        if (page === undefined) {
            response.writeHead(204, { "cache-control": "no-store", "x-closed": "1" });
            response.end();

            return;
        }

        const gone = new AbortController();

        response.on("close", () => gone.abort());
        const frame = await page.frame(
            Number(url.searchParams.get("after") ?? 0) || 0,
            gone.signal,
        );

        if (response.destroyed) {
            return;
        }

        if (frame === undefined) {
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();

            return;
        }

        response.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": String(frame.data.length),
            "cache-control": "no-store",
            "x-seq": String(frame.seq),
            "x-width": String(frame.width),
            "x-height": String(frame.height),
        });
        response.end(frame.data);

        return;
    }

    if (action === "console" && method === "GET") {
        return json(response, 200, { entries: browsers.page(key)?.logs() ?? [] });
    }

    if (action === "servers" && method === "GET") {
        // What runs on this machine, and its pages' titles, is the owner's to see.
        if (user.role !== "owner") {
            return json(response, 200, { servers: [] });
        }

        return json(response, 200, { servers: await localServers([port]) });
    }

    if (method !== "POST" || action === undefined || !BROWSER_ACTIONS.has(action)) {
        throw new HttpError(404, "Unknown browser route");
    }

    await app.requireDriver(id, user);
    await app.conversation(id);
    const body = await readJson<Record<string, unknown>>(request);

    // Typing into, stopping, or clearing a page that is not open opens nothing.
    if (action === "input" || action === "stop" || action === "clear") {
        const page = browsers.page(key);

        if (page === undefined) {
            throw new HttpError(409, "Nothing is open in the browser.");
        }

        if (action === "input") {
            if (!Array.isArray(body.events)) {
                throw new HttpError(400, "events must be a list");
            }

            await page.input(body.events.slice(0, 200)).catch(readable);

            return json(response, 200, { ok: true });
        }

        if (action === "stop") {
            await page.stop().catch(readable);
        } else {
            page.clearLogs();
        }

        return json(response, 200, browsers.state(key));
    }

    const viewport = viewportFrom(body.viewport);
    const target =
        action === "navigate"
            ? normalizeUrl(String(body.url ?? ""), {
                  trusted: user.role === "owner",
                  cwd: app.cwdOf(id),
              })
            : undefined;

    if (action === "navigate" && target === undefined) {
        throw new HttpError(
            400,
            user.role === "owner"
                ? "That is not an address: try localhost:5173, example.com, or a file path."
                : "That is not a web address: try localhost:5173 or example.com.",
        );
    }

    if (action === "viewport" && viewport === undefined) {
        throw new HttpError(400, "Say mobile, tablet, desktop, or a size such as 1024x768.");
    }

    try {
        // Opening restores the last address without waiting for it: frames show it loading.
        const page = await browsers.open(key, {
            wait: false,
            restore: action !== "navigate",
            ...(viewport === undefined ? {} : { viewport }),
        });

        if (action === "open") {
            return json(response, 200, browsers.state(key));
        }

        if (action === "navigate") {
            // Everyone in the session sees what people open: the browser reaches what this machine reaches.
            void app.collab.activity(
                id,
                user,
                `opened ${displayUrl(target!) || target!} in the browser`,
                false,
            );
            const result = await page.navigate(target!, { wait: false });

            return json(response, 200, {
                ...browsers.state(key),
                ...(result.error === undefined ? {} : { error: result.error }),
            });
        }

        if (action === "back" || action === "forward") {
            await page.go(action === "back" ? -1 : 1, { wait: false });
        } else if (action === "reload") {
            await page.reload({ wait: false });
        } else if (action === "viewport") {
            await page.setViewport(viewport!);
        }

        return json(response, 200, browsers.state(key));
    } catch (error) {
        readable(error);
    }
}

/** The same panel protocol, with every page operation executed on the chosen worker. */
async function remoteRoutes(
    api: ApiRequest,
    id: ConversationId,
    action: string | undefined,
    port: number,
): Promise<void> {
    const { app, request, response, url, user } = api;
    const key = Number(id);
    const method = request.method ?? "GET";

    if (action === undefined && method === "GET") {
        await app.browsers.remote(key, "state");

        return json(response, 200, app.browsers.state(key));
    }

    if (action === "console" && method === "GET") {
        return json(response, 200, await app.browsers.remote(key, "console"));
    }

    if (action === "servers" && method === "GET") {
        return json(
            response,
            200,
            user.role === "owner"
                ? await app.browsers.remote(key, "servers", { excludePorts: [port] })
                : { servers: [] },
        );
    }

    if (action === "frame" && method === "GET") {
        const frame = await app.browsers.remote<{
            data: string;
            seq: number;
            width: number;
            height: number;
        } | null>(key, "frame", { after: Number(url.searchParams.get("after") ?? 0) || 0 });

        if (response.destroyed) {
            return;
        }

        if (frame === null) {
            response.writeHead(204, {
                "cache-control": "no-store",
                ...(app.browsers.state(key).open ? {} : { "x-closed": "1" }),
            });
            response.end();

            return;
        }

        const bytes = Buffer.from(frame.data, "base64");

        response.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": String(bytes.length),
            "cache-control": "no-store",
            "x-seq": String(frame.seq),
            "x-width": String(frame.width),
            "x-height": String(frame.height),
        });
        response.end(bytes);

        return;
    }

    if (method !== "POST" || action === undefined || !BROWSER_ACTIONS.has(action)) {
        throw new HttpError(404, "Unknown browser route");
    }

    await app.requireDriver(id, user);
    await app.conversation(id);
    const body = await readJson<Record<string, unknown>>(request);
    const result = await app.browsers.remote(key, "action", {
        action,
        body,
        trusted: user.role === "owner",
    });

    if (action === "navigate") {
        const target = app.browsers.state(key).url;

        void app.collab.activity(
            id,
            user,
            `opened ${displayUrl(target) || target} in the browser`,
            false,
        );
    }

    return json(response, 200, result);
}
