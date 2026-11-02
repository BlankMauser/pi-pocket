// Browser-independent dictation lifecycle. Speech and cleanup are injected for deterministic, no-charge tests.
export function placeDictation(base, from, to, words) {
    const before = base.slice(0, from);
    const after = base.slice(to);
    const left = words && before && !/\s$/.test(before) && !/^[,.;:!?)]/.test(words) ? " " : "";
    const right = words && after && !/^\s|^[,.;:!?)]/.test(after) ? " " : "";

    return {
        value: `${before}${left}${words}${right}${after}`,
        caret: before.length + left.length + words.length,
    };
}

export function createDictation({
    Recognition,
    read,
    write,
    clean,
    change,
    error,
    settled,
    language = "en-US",
}) {
    let recognition = null;
    let wanted = false;
    let finishing = false;
    let polishing = false;
    let timer;
    let epoch = 0;
    let abort;
    let base = "";
    let from = 0;
    let to = 0;
    let kept = "";
    let words = "";
    let rendered = "";
    let scope;
    let undo = null;
    const report = () =>
        change({ listening: wanted, finishing, polishing, hasUndo: undo !== null });

    const cancel = () => {
        epoch++;
        wanted = finishing = polishing = false;
        clearTimeout(timer);
        abort?.abort();
        abort = null;
        const old = recognition;

        recognition = null;
        undo = null;

        try {
            old?.abort();
        } catch {
            // Already ended.
        }

        report();
    };

    const finish = async () => {
        finishing = false;
        const original = rendered;
        const raw = words;
        const expectedEpoch = epoch;

        if (!raw.trim() || !clean || read().text !== original || read().scope !== scope) {
            if (raw.trim() && read().text === original && read().scope === scope) {
                settled?.({ scope, value: original, inserted: raw });
            }

            report();

            return;
        }

        const controller = new AbortController();

        abort = controller;
        polishing = true;
        report();

        try {
            const corrected = await clean(raw, controller.signal, scope);

            if (
                epoch !== expectedEpoch ||
                read().scope !== scope ||
                read().text !== original ||
                controller.signal.aborted
            ) {
                return;
            }

            if (typeof corrected === "string" && corrected !== raw && corrected.trim()) {
                const result = placeDictation(base, from, to, corrected);

                undo = { raw: original, corrected: result.value };
                write(result.value, result.caret);
                settled?.({ scope, value: result.value, inserted: corrected });
            } else if (typeof corrected === "string") {
                settled?.({ scope, value: original, inserted: raw });
            }
        } catch (err) {
            if (epoch === expectedEpoch && !controller.signal.aborted) {
                error(`Voice cleanup failed; raw words kept. ${err.message ?? err}`);
            }
        } finally {
            if (epoch === expectedEpoch) {
                polishing = false;
                abort = null;
                report();
            }
        }
    };

    const stop = () => {
        if (!wanted) {
            return;
        }

        wanted = false;
        finishing = true;
        clearTimeout(timer);
        report();

        // Give the browser time to return its final result. An engine that never ends cannot hold the composer.
        timer = setTimeout(() => {
            const old = recognition;

            recognition = null;

            try {
                old?.abort();
            } catch {
                // Already ended.
            }

            void finish();
        }, 1500);

        try {
            recognition?.stop();
        } catch {
            clearTimeout(timer);
            recognition = null;
            void finish();
        }
    };

    const begin = () => {
        const next = new Recognition();

        recognition = next;
        next.continuous = true;
        next.interimResults = true;
        next.lang = language;

        next.onresult = (event) => {
            if (recognition !== next) {
                return;
            }

            if (read().text !== rendered || read().scope !== scope) {
                cancel();

                return;
            }

            const parts = [];

            for (let index = 0; index < event.results.length; index++) {
                parts.push(event.results[index][0].transcript.trim());
            }

            words = [kept, ...parts].filter(Boolean).join(" ");
            const result = placeDictation(base, from, to, words);

            rendered = result.value;
            write(result.value, result.caret);
        };

        next.onerror = (event) => {
            if (recognition !== next || event.error === "no-speech" || event.error === "aborted") {
                return;
            }

            cancel();
            error(event.error);
        };

        next.onend = () => {
            if (recognition !== next) {
                return;
            }

            recognition = null;
            kept = words;

            if (wanted) {
                try {
                    begin();

                    return;
                } catch (err) {
                    cancel();
                    error(err.message ?? String(err));

                    return;
                }
            }

            clearTimeout(timer);
            void finish();
        };

        next.start();
    };

    return {
        start() {
            cancel();
            const selection = read();

            scope = selection.scope;
            base = rendered = selection.text;
            from = selection.from;
            to = selection.to;
            kept = words = "";
            wanted = true;

            try {
                begin();
                // At most one minute per dictation, then one bounded cleanup request.
                timer = setTimeout(stop, 60_000);
                report();
            } catch (err) {
                cancel();
                error(err.message ?? String(err));
            }
        },
        stop,
        cancel,
        undo() {
            if (undo && read().scope === scope && read().text === undo.corrected) {
                const value = undo.raw;

                cancel();
                write(value, value.length);
            }
        },
    };
}
