// Owner-visible status of the host's quota-switching timers. Loading errors never mean "off".
import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, navigate, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

const when = (value) => (value ? new Date(value).toLocaleString() : "Not reported");

export function watchdogDecision(row) {
    if (row.switched) {
        return "Switched provider";
    }

    return (
        {
            ok: "Kept current provider",
            switch: "Switch not verified",
            stuck: "No provider with verified quota",
            unknown: "Quota unknown; no switch",
            stopped: "Stopped",
        }[row.lastAction] ?? "No check recorded"
    );
}

export function WatchdogList() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [stopping, setStopping] = useState(null);
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        let disposed = false;
        let reading = false;

        const read = async () => {
            if (reading) {
                return;
            }

            reading = true;

            try {
                const result = await api("usage-watchdogs");

                if (!disposed) {
                    setData(result);
                    setError(null);
                }
            } catch {
                if (!disposed) {
                    setError("Could not read watchdogs. Their current status is unknown.");
                }
            } finally {
                reading = false;
            }
        };

        void read();
        const poll = setInterval(() => {
            if (!document.hidden) {
                void read();
            }
        }, 15_000);

        return () => {
            disposed = true;
            clearInterval(poll);
        };
    }, [refresh]);

    const stop = async (session) => {
        setStopping(session);

        try {
            await api("usage-watchdogs/stop", { session });
            setRefresh((value) => value + 1);
        } catch {
            setError("Could not stop this watchdog. Refresh to check its current status.");
        } finally {
            setStopping(null);
        }
    };

    const row = (watchdog) => {
        const session = store.state.sessions.find((item) => item.id === watchdog.session);
        const state = watchdog.switchingEnabled ? "On" : watchdog.stopped ? "Stopped" : "Off";

        return html`<section class="subscription-account" key=${watchdog.session} data-watchdog=${watchdog.session}>
            <div class="subscription-heading">
                <button class="button small ghost" onClick=${() => {
                    closeSheet();
                    navigate(watchdog.session);
                }}>
                    ${session?.title || `Session ${watchdog.session}`}
                </button>
                <strong>${state}</strong>
            </div>
            <p class="muted small mono">Session ${watchdog.session}${watchdog.currentProvider ? ` · ${watchdog.currentProvider}` : ""}</p>
            <p class="small">Last check: ${when(watchdog.lastCheckedAt)} · ${watchdogDecision(watchdog)}</p>
            ${watchdog.switchingEnabled && html`<p class="small">Next check: ${when(watchdog.nextCheckAt)}</p>`}
            ${watchdog.stoppedAt && html`<p class="muted small">Stopped: ${when(watchdog.stoppedAt)}</p>`}
            ${watchdog.stopped && watchdog.active && html`<p class="muted small">Switching blocked; timer cleanup is pending.</p>`}
            ${(watchdog.active || watchdog.enabled) && html`<button class="button small" disabled=${stopping !== null} onClick=${() => stop(watchdog.session)}>${stopping === watchdog.session ? "Stopping…" : "Stop watchdog"}</button>`}
        </section>`;
    };

    const active =
        data?.watchdogs.filter((item) => item.switchingEnabled || item.active || item.enabled) ??
        [];
    const past =
        data?.watchdogs.filter((item) => !item.switchingEnabled && !item.active && !item.enabled) ??
        [];

    return html`<div data-usage-watchdogs>
        <p class="muted small">These timers can change a session’s model provider when quota runs low. They run on the server, even when Pocket is closed. Times use this device’s time zone.</p>
        <button class="button small" onClick=${() => setRefresh((value) => value + 1)}>Refresh watchdogs</button>
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        ${!data && !error && html`<${Loader} label="Reading watchdogs" />`}
        ${data?.available === false && html`<p class="muted">${data.message}</p>`}
        ${data?.available && !error && html`<p role="status">${data.watchdogs.filter((item) => item.switchingEnabled).length} active usage watchdogs</p>`}
        ${error && data && html`<p class="muted small">Last known status shown below.</p>`}
        ${active.map(row)}
        ${past.length > 0 && html`<details><summary>Stopped and inactive watchdogs (${past.length})</summary>${past.map(row)}</details>`}
    </div>`;
}

export function UsageWatchdogsSheet() {
    return html`<${Sheet} title="Usage watchdogs" onClose=${closeSheet}><${WatchdogList} /><//>`;
}
