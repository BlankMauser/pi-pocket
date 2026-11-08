/**
 * Native drop-in imports retain the pre-1.4 document checkpoint default without changing Pi Durable itself. On Node a
 * module hook gives drop-ins the compat namespace; Bun has no `registerHooks`, so the native build's SDK bridge serves
 * it at `NATIVE_COMPAT_ADDRESS` instead (`build-pocket-bolt.py`).
 */
import * as nodeModule from "node:module";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";

const compatUrl = new URL("./extension-document-compat.ts", import.meta.url).href;
const piAiUrl = new URL("./extension-pi-ai-compat.ts", import.meta.url).href;

type Scope = { directory: string; report: (message: string) => void; warned: Set<string> };
type Owner = { scope: Scope; module: string; root: string };
const scopes = new Map<string, Scope>();
const owners = new Map<string, Owner>();
let registered = false;

function ownerOf(url: string): Owner | undefined {
    const known = owners.get(url);

    if (known !== undefined) {
        return known;
    }

    for (const scope of scopes.values()) {
        if (url.startsWith(scope.directory)) {
            const module = decodeURIComponent(url.slice(scope.directory.length).split(/[/?#]/)[0]!);

            return { scope, module: module.replace(/\.ts$/, ""), root: scope.directory };
        }
    }

    return undefined;
}

/** Add one loader's drop-in folder. The native hook also follows explicitly symlinked extension source files. */
export function documentImports(directory: string, report: (message: string) => void): () => void {
    const folder = pathToFileURL(directory.endsWith(sep) ? directory : directory + sep).href;
    const scope: Scope = { directory: folder, report, warned: new Set() };

    scopes.set(folder, scope);

    if (!registered && typeof nodeModule.registerHooks === "function") {
        nodeModule.registerHooks({
            resolve(specifier, context, nextResolve) {
                const parent =
                    context.parentURL === undefined ? undefined : ownerOf(context.parentURL);

                if (specifier === "@earendil-works/pi-durable" && parent !== undefined) {
                    const target = new URL(compatUrl);

                    target.searchParams.set("folder", parent.scope.directory);
                    target.searchParams.set("module", parent.module);

                    return { url: target.href, shortCircuit: true };
                }

                if (specifier === "@earendil-works/pi-ai" && parent !== undefined) {
                    return { url: piAiUrl, shortCircuit: true };
                }

                const resolved = nextResolve(specifier, context);
                // Node resolves symlinks before the next parentURL. Follow only imports inside extension source
                // trees, not arbitrary shared dependencies: a shared helper can also run on behalf of core.
                const requestedUrl = specifier.startsWith("file:")
                    ? specifier
                    : parent !== undefined && specifier.startsWith(".")
                      ? new URL(specifier, context.parentURL).href
                      : undefined;
                const requested =
                    requestedUrl === undefined
                        ? undefined
                        : parent !== undefined && requestedUrl.startsWith(parent.root)
                          ? parent
                          : ownerOf(requestedUrl);
                const owner =
                    parent !== undefined && resolved.url.startsWith(parent.root)
                        ? parent
                        : (requested ?? ownerOf(resolved.url));

                if (owner !== undefined && resolved.url.startsWith("file:")) {
                    owners.set(
                        resolved.url,
                        resolved.url.startsWith(owner.root)
                            ? owner
                            : { ...owner, root: new URL("./", resolved.url).href },
                    );
                }

                return resolved;
            },
        });
        registered = true;
    }

    return () => {
        if (scopes.get(folder) === scope) {
            scopes.delete(folder);
        }

        for (const [url, owner] of owners) {
            if (owner.scope === scope) {
                owners.delete(url);
            }
        }
    };
}

/**
 * The compat namespace's address in the native build, where Bun's resolver gives every module loaded at run time (the
 * drop-ins, and built-ins edited since the build) one namespace and does not say which module imports it. It names no
 * folder, so a missing policy is reported to the first loader with a drop-in folder.
 */
export const NATIVE_COMPAT_ADDRESS = `${compatUrl}?module=${encodeURIComponent("a drop-in extension")}`;

/**
 * Copy a missing policy, including frozen definitions, without changing any stored document semantics. `address` is the
 * compat namespace's, which says whose definition it is.
 */
export function checkpointDefault<
    T extends { readonly kind: string; readonly checkpointWhen?: unknown },
>(definition: T, address: string): T {
    if (definition.checkpointWhen !== undefined) {
        return definition;
    }

    reportCheckpointDefault(address, definition.kind);

    return Object.create(Object.getPrototypeOf(definition), {
        ...Object.getOwnPropertyDescriptors(definition),
        checkpointWhen: {
            value: () => false,
            enumerable: true,
            writable: true,
            configurable: true,
        },
    }) as T;
}

/** Report each missing policy once per module and document kind in this loader. */
export function reportCheckpointDefault(compatModule: string, kind: string): void {
    const url = new URL(compatModule);
    const folder = url.searchParams.get("folder");
    const scope = folder === null ? scopes.values().next().value : scopes.get(folder);
    const module = url.searchParams.get("module") ?? "extension";
    const key = `${module}:${kind}`;

    if (scope === undefined || scope.warned.has(key)) {
        return;
    }

    scope.warned.add(key);
    scope.report(`${module}: document ${kind} has no checkpointWhen; Pi Pocket uses deltas only`);
}
