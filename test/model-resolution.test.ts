import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../src/server/models.ts";

// Pure snapshot fixture: no credential store, profile paths, or network access.
const catalog = [
    ...Array.from({ length: 35 }, (_, index) => ({ provider: "other", id: `model-${index}` })),
    { provider: "openai-codex", id: "gpt-6.1-sol" },
    { provider: "codex-zack", id: "gpt-6.1-sol" },
    { provider: "codex-zack", id: "gpt-6-luna" },
];
const models = { getAvailableSnapshot: () => catalog } as unknown as ModelRuntime;

test("reordered and mistyped model IDs suggest the requested account and list the entire catalog", () => {
    for (const id of ["gpt-sol-6.1", "gpt-6.1-slo"]) {
        assert.throws(
            () => resolveModel(models, `codex-zack/${id}`),
            (error: Error) => {
                assert.match(error.message, /Did you mean: codex-zack\/gpt-6\.1-sol/);
                const available = error.message.split("Available models (38):\n")[1]!;

                assert.ok(available.startsWith("codex-zack/"));
                assert.deepEqual(
                    available.split("\n").sort(),
                    catalog.map((model) => `${model.provider}/${model.id}`).sort(),
                );

                return true;
            },
        );
    }
});

test("resolution stays exact and never silently changes accounts", () => {
    assert.deepEqual(resolveModel(models, " codex-zack/gpt-6.1-sol "), {
        provider: "codex-zack",
        modelId: "gpt-6.1-sol",
    });
    assert.throws(
        () => resolveModel(models, "missing-account/gpt-6.1-sol"),
        (error: Error) => {
            assert.ok(!error.message.includes("Did you mean:"));
            assert.ok(error.message.includes("codex-zack/gpt-6.1-sol"));

            return true;
        },
    );
    const empty = { getAvailableSnapshot: () => [] } as unknown as ModelRuntime;

    assert.throws(() => resolveModel(empty, "anything"), /None\. Add or sign in to a provider\./);
});
