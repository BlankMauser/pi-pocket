// Learning from edits, without a model: compare what dictation put in the box with what was finally sent. A small
// replacement that sounds alike, or whose new word looks like a name, is a mis-hearing worth remembering.
const MAX_TOKENS = 600;
const MAX_RUN = 4;
const edge = /^[\s"'([{]+|[\s"')\]}.,;:!?]+$/g;
const clean = (word) => word.replace(edge, "");
const letters = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A word that looks like a name or identifier: inner capitals, digits, hyphens, dots, underscores. */
export const identifierLike = (word) =>
    word.length >= 3 &&
    word.length <= 40 &&
    /[\p{Lu}].*[\p{Lu}]|\p{Ll}\p{Lu}|[0-9]|[-_./]\p{L}/u.test(word);

function distance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];

        row[0] = i;

        for (let j = 1; j <= b.length; j++) {
            const above = row[j];

            row[j] = Math.min(
                row[j] + 1,
                row[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
            diagonal = above;
        }
    }

    return row[b.length];
}

/** Whether replacing `heard` with `wanted` reads as a fix of a mis-heard name, not a rewording. */
export function plausibleFix(heard, wanted) {
    const a = letters(heard);
    const b = letters(wanted);

    if (!a || !b || heard === wanted) {
        return false;
    }

    if (a === b) {
        return true;
    }

    return distance(a, b) / Math.max(a.length, b.length) <= 0.5 || identifierLike(wanted);
}

/** The differing runs between two word lists, as { at, removed, added } in the first list's terms. */
function runs(before, after) {
    // Case counts: "pie pocket" to "Pi Pocket" is one fix, not "pie" to "Pi" beside an unchanged "pocket".
    const key = (word) => clean(word);
    const n = before.length;
    const m = after.length;
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));

    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] =
                key(before[i]) === key(after[j])
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    const out = [];
    let i = 0;
    let j = 0;
    let current = null;

    const close = () => {
        if (current) {
            out.push(current);
            current = null;
        }
    };

    while (i < n || j < m) {
        if (i < n && j < m && key(before[i]) === key(after[j])) {
            close();
            i++;
            j++;
        } else if (j < m && (i === n || table[i][j + 1] >= table[i + 1]?.[j])) {
            current ??= { at: i, removed: [], added: [] };
            current.added.push(after[j++]);
        } else {
            current ??= { at: i, removed: [], added: [] };
            current.removed.push(before[i++]);
        }
    }

    close();

    return out;
}

/**
 * `pending` is { value, inserted }: the whole draft just after dictation and the dictated words in it. `finalText` is
 * what was sent. Returns the fixes to teach and the name-like terms that survived into the sent message.
 */
export function learnFrom(pending, finalText) {
    const before = pending.value.split(/\s+/).filter(Boolean);
    const after = finalText.split(/\s+/).filter(Boolean);

    if (before.length > MAX_TOKENS || after.length > MAX_TOKENS) {
        return { corrections: [], terms: [] };
    }

    const spoken = pending.inserted.toLowerCase();
    const corrections = [];
    const edited = new Set();

    for (const run of runs(before, after)) {
        if (
            run.removed.length < 1 ||
            run.added.length < 1 ||
            run.removed.length > MAX_RUN ||
            run.added.length > MAX_RUN
        ) {
            continue;
        }

        // A typed extra word beside a name ("claude-haiku-5-5 please") is not part of the name.
        const marked = run.added.map((word) => identifierLike(clean(word)));
        const first = marked.indexOf(true);
        const added =
            first < 0 || marked.every(Boolean)
                ? run.added
                : run.added.slice(first, marked.lastIndexOf(true) + 1);
        const heard = clean(run.removed.join(" "));
        const wanted = clean(added.join(" "));

        // Only words the dictation produced, so edits to text typed by hand teach nothing.
        if (
            !heard ||
            !wanted ||
            !spoken.includes(heard.toLowerCase()) ||
            !plausibleFix(heard, wanted)
        ) {
            continue;
        }

        corrections.push({ heard, wanted });
        edited.add(wanted);
    }

    const terms = [];

    for (const word of after) {
        const term = clean(word);

        if (
            identifierLike(term) &&
            !terms.includes(term) &&
            (pending.inserted.includes(term) || edited.has(term))
        ) {
            terms.push(term);
        }
    }

    return { corrections: corrections.slice(0, 20), terms: terms.slice(0, 20) };
}
