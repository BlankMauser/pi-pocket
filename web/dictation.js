// Audio stays with the browser's speech service. Optional cleanup sends the dictated words, a little recent chat and folder names to GPT-6 Luna.
import { useEffect, useRef, useState } from "preact/hooks";
import { createDictation } from "./dictation-core.js";
import { learnFrom } from "./dictation-learn.js";
import { api, notify, store, uid } from "./store.js";

const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

export const dictationAvailable = () => Boolean(Recognition) && globalThis.isSecureContext === true;
export const voiceCleanupEnabled = () => localStorage.getItem("pocket.voice-cleanup") !== "off";

// The latest dictation not sent yet: when it is sent, what was changed by hand teaches the vocabulary.
let pending = null;

/** Call with the text being sent. Teaches the server what dictation got wrong and which names the owner uses. */
export function learnFromSend(scope, finalText) {
    const dictated = pending;

    pending = null;

    if (!dictated || dictated.scope !== scope || Date.now() - dictated.at > 3_600_000) {
        return;
    }

    if (store.state.me?.role !== "owner" || !voiceCleanupEnabled()) {
        return;
    }

    const { corrections, terms } = learnFrom(dictated, finalText);

    if (corrections.length > 0 || terms.length > 0) {
        // Best effort: learning never holds up a message or reports an error.
        api("dictation/learn", { corrections, terms }).catch(() => {});
    }
}

const REASONS = {
    "not-allowed": "Microphone access is blocked. Allow it in your browser's site settings.",
    "service-not-allowed":
        "Speech recognition is unavailable here. Try your keyboard's microphone key.",
    "audio-capture": "No microphone was found.",
    network: "The browser's speech service needs a network connection.",
};

export function useDictation({ read, write }) {
    const [status, setStatus] = useState({
        listening: false,
        finishing: false,
        polishing: false,
        hasUndo: false,
    });
    const latest = useRef({ read, write });
    const controller = useRef(null);

    latest.current = { read, write };

    if (!controller.current) {
        controller.current = createDictation({
            Recognition,
            finalResultTimeoutMs: Recognition?.finalResultTimeoutMs,
            language: navigator.language || "en-US",
            read: () => latest.current.read(),
            write: (value, at) => latest.current.write(value, at),
            change: setStatus,
            settled: (info) => {
                pending = { ...info, at: Date.now() };
            },
            error: (message) => notify("warning", REASONS[message] ?? message),
            clean: async (text, signal, conversationId) => {
                if (store.state.me?.role !== "owner" || !voiceCleanupEnabled()) {
                    return text;
                }

                const result = await api(
                    "dictation/cleanup",
                    {
                        text,
                        conversationId,
                        requestId: uid(),
                    },
                    { signal },
                );

                return result.text;
            },
        });
    }

    useEffect(() => {
        const onHidden = () => {
            if (document.hidden) {
                controller.current.cancel();
            }
        };

        document.addEventListener("visibilitychange", onHidden);

        return () => {
            document.removeEventListener("visibilitychange", onHidden);
            controller.current.cancel();
        };
    }, []);

    return {
        ...status,
        available: dictationAvailable(),
        cancel: controller.current.cancel,
        undo: controller.current.undo,
        toggle: () => (status.listening ? controller.current.stop() : controller.current.start()),
    };
}
