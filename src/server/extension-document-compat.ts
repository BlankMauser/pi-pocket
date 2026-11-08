/** The drop-in-only Pi Durable namespace: every export keeps its identity except the 2 document constructors. */
import * as durable from "@earendil-works/pi-durable";
import { checkpointDefault } from "./extension-document-imports.ts";

export * from "@earendil-works/pi-durable";

export const defineDoc = ((definition: Parameters<typeof durable.defineDoc>[0]) =>
    durable.defineDoc(checkpointDefault(definition, import.meta.url))) as typeof durable.defineDoc;

export const defineDocFamily = ((definition: Parameters<typeof durable.defineDocFamily>[0]) =>
    durable.defineDocFamily(
        checkpointDefault(definition, import.meta.url),
    )) as typeof durable.defineDocFamily;
