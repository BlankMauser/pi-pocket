// OpenAI Fast (priority): one switch for every OpenAI request, owner only, and a bounded recent-conversation tail.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { installFastMode, supportsFast, withPriority } from "../src/server/fast-mode.ts";
import { type App, cleanUp, newSession, openApp, owner, say, scriptedModel } from "./helpers.ts";

const codex: any = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" };
const responses: any = { api: "openai-responses", provider: "openai", id: "gpt-5.5" };
const claude: any = { api: "anthropic-messages", provider: "anthropic", id: "claude" };

function runtime() {
    const calls: any[] = [];

    return {
        calls,
        models: {
            streamSimple: (model: any, _context: any, options: any) => {
                calls.push({ model, options });

                return {} as never;
            },
        } as any,
    };
}

test("only OpenAI request APIs can ask for priority", () => {
    assert.equal(supportsFast(codex), true);
    assert.equal(supportsFast(responses), true);
    assert.equal(supportsFast(claude), false);
    assert.equal(supportsFast(undefined), false);
});

test("the switch adds priority to OpenAI requests, keeps other payload edits, and leaves others alone", async () => {
    const { calls, models } = runtime();
    let on = false;

    installFastMode(models, () => on);
    models.streamSimple(codex, {}, { reasoning: "high" });
    assert.equal(calls[0].options.onPayload, undefined, "off: untouched");

    on = true;
    models.streamSimple(claude, {}, { reasoning: "high" });
    assert.equal(calls[1].options.onPayload, undefined, "other providers: untouched");

    models.streamSimple(
        codex,
        {},
        { reasoning: "high", onPayload: (body: any) => ({ ...body, store: false }) },
    );
    assert.equal(calls[2].options.reasoning, "high");
    assert.deepEqual(await calls[2].options.onPayload({ model: "x" }, codex), {
        model: "x",
        store: false,
        service_tier: "priority",
    });

    models.streamSimple(responses, {}, undefined);
    assert.equal((await calls[3].options.onPayload({}, responses)).service_tier, "priority");
});

test("a request that sets priority itself still leaves non-OpenAI models alone", async () => {
    const options = withPriority({ maxTokens: 5 });

    assert.equal(options.maxTokens, 5);
    assert.deepEqual(await options.onPayload!({ a: 1 }, claude), { a: 1 });
});

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("only the owner turns Fast mode on, it reaches every tab, and it persists", async () => {
    const guest = app.config.addUser("Guest", "guest").user;

    assert.equal((await app.hello(owner(app))).server.openaiFast, false);
    await assert.rejects(app.setOpenAiFast(guest, true), { status: 403 });
    await assert.rejects(app.setOpenAiFast(owner(app), "yes"), { status: 400 });
    await app.setOpenAiFast(owner(app), true);
    assert.equal(app.config.openaiFast, true);
    assert.equal((await app.hello(guest)).server.openaiFast, true);
    await app.setOpenAiFast(owner(app), false);
    assert.equal(app.config.openaiFast, false);
});

test("the conversation tail is short, plain text, newest last, without tools or sender tags", async () => {
    const id = await newSession(app);

    await say(app, id, "first question about HareDream");
    await say(app, id, "x".repeat(900) + " the ending that matters");
    const tail = await app.transcripts.recentText(id, 3, 200, 1000);
    const lines = tail.split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "Pi: echo: first question about HareDream");
    assert.match(lines[1]!, /^Person: …x+ the ending that matters$/);
    assert.match(lines[2]!, /^Pi: …x+ the ending that matters$/);
    assert.ok(lines.every((line) => line.length <= 215));
    assert.ok(tail.length <= 1000);
    assert.doesNotMatch(tail, /\[from:/);
});
