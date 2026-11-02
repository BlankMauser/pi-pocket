// Voice settings belong to this browser; the owner's small vocabulary Markdown file belongs to the server.
import { useEffect, useState } from "preact/hooks";
import { voiceCleanupEnabled } from "../dictation.js";
import { api, closeSheet, notify } from "../store.js";
import { html, Sheet, Switch } from "../ui.js";

export function VoiceSheet() {
    const [enabled, setEnabled] = useState(voiceCleanupEnabled);
    const [loaded, setLoaded] = useState(null);
    const [text, setText] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [learned, setLearned] = useState(null);

    const loadLearned = () =>
        api("dictation/learned")
            .then(setLearned)
            .catch(() => setLearned(false));

    useEffect(() => {
        loadLearned();
    }, []);

    const forget = async (kind, key) => {
        try {
            await api("dictation/forget", { kind, key });
            await loadLearned();
        } catch (err) {
            setError(err.message);
        }
    };

    useEffect(() => {
        const controller = new AbortController();

        api("dictation/vocabulary", undefined, { signal: controller.signal })
            .then((value) => {
                setLoaded(value);
                setText(value.text);
            })
            .catch((err) => {
                if (!controller.signal.aborted) {
                    setError(err.message);
                }
            });

        return () => controller.abort();
    }, []);

    const save = async () => {
        setSaving(true);
        setError("");

        try {
            const value = await api("dictation/vocabulary", { text, revision: loaded.revision });

            setLoaded(value);
            notify("info", "Vocabulary saved. Your next dictation uses it.");
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    return html`<${Sheet} title="Voice settings" onClose=${closeSheet}>
        <div class="voice-toggle">
            <span>Clean dictation<br /><strong>GPT-6 Luna · medium</strong></span>
            <${Switch} label="Clean dictation with GPT-6 Luna · medium" on=${enabled} onChange=${() => {
                localStorage.setItem("pocket.voice-cleanup", !enabled ? "on" : "off");
                setEnabled(!enabled);
            }} />
        </div>
        <p class="muted small">One text-only request when you stop, always on OpenAI Fast (priority), which may use more of your openai-codex quota. It sends the dictated words, your vocabulary, the last few messages of this session, and your working folder with the names of the folders around it, so repository names come out right. No tools, files, audio upload, or automatic sending. A failed cleanup leaves the raw text.</p>
        ${learned && html`<${Stats} usage=${learned.usage} />`}
        <div class="field">
            <label for="voice-vocabulary">Common vocabulary (.md)</label>
            <p class="muted small">Names the folder listing does not cover, and spoken aliases. Repository folders are picked up automatically. Reference data only; no secrets. Shared across your owner sessions on this server. Edit here or ask Pi to update the file.</p>
            ${loaded && html`<code class="voice-path">${loaded.path}</code>`}
            ${!loaded && !error && html`<p role="status">Loading vocabulary…</p>`}
            <textarea id="voice-vocabulary" rows="10" maxlength="8000" disabled=${!loaded || saving} value=${text} onInput=${(event) => setText(event.currentTarget.value)}></textarea>
            <span class="muted small">${text.length}/8000 characters</span>
        </div>
        ${error && html`<p role="alert" class="warn">${error}</p>`}
        <button class="button primary wide" disabled=${!loaded || saving} onClick=${save}>${saving ? "Saving…" : "Save vocabulary"}</button>
        ${learned && html`<${Learned} learned=${learned} forget=${forget} />`}
    <//>`;
}

const money = (value) => (value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

function Stats({ usage }) {
    const rows = [
        ["Today", usage.today],
        ["Last 7 days", usage.last7Days],
        ["Last 30 days", usage.last30Days],
    ];

    return html`<div class="field voice-stats">
        <label>Cleanup usage</label>
        <p class="muted small">
            Estimated at list price; a subscription is metered in quota, not dollars. Cached is how much of the input OpenAI
            reused from earlier requests.
        </p>
        ${rows.map(
            ([name, row]) => html`<p class="small" key=${name}>
                <strong>${name}</strong>: ${row.cleanups} cleanups · ${money(row.cost)}${
                    row.cleanups > 0 &&
                    ` · ${row.averageSeconds.toFixed(1)}s each · ${row.inputTokens + row.outputTokens} tokens · ${Math.round(
                        (100 * row.cachedInputTokens) /
                            Math.max(1, row.inputTokens + row.cachedInputTokens),
                    )}% cached`
                }
            </p>`,
        )}
    </div>`;
}

function Learned({ learned, forget }) {
    const { corrections, terms } = learned;

    return html`<div class="field voice-learned">
        <label>Learned from your edits</label>
        <p class="muted small">
            When you fix a mis-heard word before sending, it is remembered, and so are names you keep using. It is worked out in your
            browser with no model call, and stored on this server. Remove anything wrong.
        </p>
        ${corrections.length === 0 && terms.length === 0 && html`<p class="muted small">Nothing learned yet.</p>`}
        ${corrections.slice(0, 60).map(
            (each) => html`<div class="voice-learned-row" key=${each.heard}>
                <span>${each.heard} → <strong>${each.wanted}</strong>${each.count > 1 && ` ×${each.count}`}</span>
                <button class="button small" onClick=${() => forget("correction", each.heard)} aria-label=${`Forget ${each.heard}`}>
                    Forget
                </button>
            </div>`,
        )}
        ${terms.slice(0, 60).map(
            (each) => html`<div class="voice-learned-row" key=${`term-${each.term}`}>
                <span><strong>${each.term}</strong> · used ${each.count}× ${each.count < 3 && html`<span class="muted">(not used yet)</span>`}</span>
                <button class="button small" onClick=${() => forget("term", each.term)} aria-label=${`Forget ${each.term}`}>
                    Forget
                </button>
            </div>`,
        )}
    </div>`;
}
