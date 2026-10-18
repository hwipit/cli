import type { SealedFileMeta } from './crypto.js';

/**
 * Files attached to a sealed answer of `hwip ask`. The answer's seal names each file (`SealedFileMeta`:
 * its real name, type and size, matched by `iv`); the response's wire `files` carry the sealed bytes'
 * `fileKey` and one wrapped key per device. The bytes are fetched and opened by the listener's
 * `downloadSealedEach` — the same fetch and open as a sealed command's attachments, one file at a time — into
 * `~/.hwip/attachments/<eventId>/`.
 */

/** One wire file as the server keeps it for a sealed answer (hwip `server/src/functions/hooks.ts`). */
export interface AnswerWireFile {
    fileKey: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    iv: string;
    deviceKeyMap: Record<string, string>;
}

export interface SavedAnswerFiles {
    /** Absolute paths of the files saved. */
    paths: string[];
    /** One `<name>: <why>` per file the seal names that was not saved. */
    missing: string[];
}

/** Who opens the files: this machine's slot, and the phone key the answer's seal was checked against. */
export interface AnswerFileOpener {
    deviceId: string;
    senderPublicKey: string;
}

/** The listener's per-file sealed download (`listener.ts` `downloadSealedEach`): each file saved or named with why. */
export type DownloadSealed = (
    dirId: string,
    files: AnswerWireFile[],
    sealed: AnswerFileOpener & { files: SealedFileMeta[] },
) => Promise<SavedAnswerFiles>;

/** A relay's wire file, parsed: an object with a fileKey, an iv and a key map. */
const isWireFile = (f: unknown): f is AnswerWireFile => {
    if (typeof f !== 'object' || f === null) return false;
    const { fileKey, iv, deviceKeyMap } = f as { fileKey?: unknown; iv?: unknown; deviceKeyMap?: unknown }; // reading an unknown object's fields, each checked here
    return typeof fileKey === 'string' && fileKey !== '' && typeof iv === 'string' && typeof deviceKeyMap === 'object' && deviceKeyMap !== null;
};

/**
 * Save what the seal names and the wire delivered for this machine. A file the seal names with no wire
 * file, or no slot here, is reported missing; the rest go to the listener's download in the seal's
 * order, each saved or reported on its own. A download that throws as a whole reports each file with why.
 */
export const saveAnswerFiles = async (
    eventId: string,
    wire: unknown,
    metas: SealedFileMeta[],
    opener: AnswerFileOpener,
    download: DownloadSealed,
): Promise<SavedAnswerFiles> => {
    const given = Array.isArray(wire) ? wire.filter(isWireFile) : [];
    const pairs = metas.map((meta) => ({
        meta,
        file: given.find((f) => f.iv === meta.iv && typeof f.deviceKeyMap[opener.deviceId] === 'string'),
    }));
    const missing = pairs.filter((p) => !p.file).map((p) => `${p.meta.name}: not delivered`);
    const delivered = pairs.flatMap((p) => (p.file ? [{ meta: p.meta, file: p.file }] : []));
    if (delivered.length === 0) return { paths: [], missing };
    try {
        const saved = await download(eventId, delivered.map((d) => d.file), { ...opener, files: delivered.map((d) => d.meta) });
        return { paths: saved.paths, missing: [...missing, ...saved.missing] };
    } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { paths: [], missing: [...missing, ...delivered.map((d) => `${d.meta.name}: ${why}`)] };
    }
};
