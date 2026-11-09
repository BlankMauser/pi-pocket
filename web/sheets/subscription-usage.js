import { useEffect, useState } from "preact/hooks";
import { api, closeSheet, openSheet } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";
const number = (value) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const time = (value) =>
    new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    });

export function resetLabel(value, now = Date.now()) {
    if (!value) {
        return "Reset time not reported";
    }

    const minutes = Math.ceil((Date.parse(value) - now) / 60_000);

    if (!Number.isFinite(minutes)) {
        return "Reset time not reported";
    }

    if (minutes <= 0) {
        return "Reset due · awaiting provider update";
    }

    const days = Math.floor(minutes / 1440),
        hours = Math.floor((minutes % 1440) / 60);

    return `Resets in ${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${minutes % 60}m`;
}

export function SubscriptionUsageSheet() {
    const [data, setData] = useState(null),
        [error, setError] = useState(null),
        [loading, setLoading] = useState(true),
        [now, setNow] = useState(Date.now());

    const load = async () => {
        setLoading(true);

        try {
            setData(await api("subscription-usage"));
            setError(null);
        } catch {
            setError("Could not reach the usage monitor. Your accounts are still saved.");
        } finally {
            setLoading(false);
            setNow(Date.now());
        }
    };

    useEffect(() => {
        let disposed = false;

        const read = async () => {
            try {
                const result = await api("subscription-usage");

                if (!disposed) {
                    setData(result);
                    setError(null);
                }
            } catch {
                if (!disposed) {
                    setError("Could not reach the usage monitor. Your accounts are still saved.");
                }
            } finally {
                if (!disposed) {
                    setLoading(false);
                    setNow(Date.now());
                }
            }
        };

        void read();
        const tick = setInterval(() => setNow(Date.now()), 30_000);
        const poll = setInterval(() => {
            if (!document.hidden) {
                void read();
            }
        }, 300_000);

        return () => {
            disposed = true;
            clearInterval(tick);
            clearInterval(poll);
        };
    }, []);
    const next = data?.accounts.reduce(
        (soonest, account) => Math.min(soonest, Date.parse(account.nextCheckAt)),
        Infinity,
    );
    const cooling = next !== undefined && Number.isFinite(next) && next > now;

    return html`<${Sheet} title="Subscription usage" onClose=${closeSheet}>
        <button class="button small" onClick=${() => openSheet({ type: "usage-watchdogs" })}>Usage watchdogs</button>
        <p class="muted small">Account-wide allowances, including use from other machines. Reset times use this device’s time zone. Checks update every five minutes while this view is open.</p>
        <div class="subscription-toolbar"><button class="button small" disabled=${loading || cooling} onClick=${load}>${loading ? "Checking…" : "Refresh"}</button>${cooling && html`<span class="muted small">Next check in ${Math.max(1, Math.ceil((next - now) / 60_000))}m</span>`}</div>
        ${error && html`<p class="error-box" role="alert">${error}</p>`}
        ${loading && !data && html`<${Loader} label="Checking subscription limits" />`}
        ${data?.accounts.length === 0 && html`<p class="muted">No Claude or Codex accounts are configured on this server.</p>`}
        ${data?.accounts.map(
            (account) => html`<section class="subscription-account" key=${account.id}>
            <div class="subscription-heading"><strong>${account.name}</strong><span class="muted small mono">${account.id}</span></div>
            ${account.checkedAt && html`<p class="muted small">${account.stale ? "Last known usage" : "Checked"} · ${time(account.checkedAt)}</p>`}
            ${account.message && html`<p class="muted small" role="status">${account.message}</p>`}
            ${account.windows.map(
                (window) => html`<div class="subscription-window" key=${window.id}>
                <div class="subscription-heading"><span>${window.label}</span><span class="mono">${number(Math.max(0, 100 - window.usedPercent))}% left</span></div>
                <div class="subscription-meter" role="progressbar" aria-label=${`${window.label} used`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.min(100, window.usedPercent)} aria-valuetext=${`${number(window.usedPercent)}% used${account.stale ? ", last known" : ""}`}><span style=${`width:${Math.min(100, window.usedPercent)}%`}></span></div>
                <div class="subscription-heading muted small"><span>${number(window.usedPercent)}% used</span><span>${resetLabel(window.resetAt, now)}</span></div>
                ${window.resetAt && html`<div class="muted small subscription-reset">${time(window.resetAt)}</div>`}
            </div>`,
            )}
        </section>`,
        )}
    <//>`;
}
