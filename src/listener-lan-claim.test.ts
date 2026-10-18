import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimLanFile, displayFolder, gcAttachments, handlePush } from './listener.js';
import { getDevicePublicKey, initDeviceCrypto } from './crypto.js';
import { LAN_LANDED_IV } from './lan-receiver.js';
import { v2Party } from '../tests/helpers/seal.js';

// The last step of a local transfer: the receiver left the decrypted file
// in the landing zone, the push record arrives over the WebSocket, and the
// file moves to Downloads. Pinned: the never-overwrite rule survives the
// move, a missing transfer is a quiet null, and orphans get swept.

const zone = () => {
    const landing = mkdtempSync(join(tmpdir(), 'hwip-landing-'));
    const downloads = mkdtempSync(join(tmpdir(), 'hwip-downloads-'));
    const land = (transferId: string, fileName: string, content: string) => {
        mkdirSync(join(landing, transferId), { recursive: true });
        writeFileSync(join(landing, transferId, fileName), content);
    };
    return { landing, downloads, land };
};

describe('claimLanFile', () => {
    it('moves <landing>/<transferId>/<fileName> to Downloads and removes the transfer dir', () => {
        const z = zone();
        z.land('tr_1', 'a.txt', 'A');
        const dest = claimLanFile({ fileName: 'a.txt', transferId: 'tr_1' }, z.landing, z.downloads);
        expect(dest).toBe(join(z.downloads, 'a.txt'));
        expect(readFileSync(dest ?? '').toString()).toBe('A');
        expect(existsSync(join(z.landing, 'tr_1'))).toBe(false);
    });

    it('never overwrites: a second file of the same name becomes name (2)', () => {
        const z = zone();
        writeFileSync(join(z.downloads, 'a.txt'), 'old');
        z.land('tr_2', 'a.txt', 'new');
        const dest = claimLanFile({ fileName: 'a.txt', transferId: 'tr_2' }, z.landing, z.downloads);
        expect(dest).toBe(join(z.downloads, 'a (2).txt'));
        expect(readFileSync(join(z.downloads, 'a.txt')).toString()).toBe('old');
    });

    // The sender pads a sealed file before it seals it, whichever way the bytes
    // travel: the size the sealed body gives is what the file is cut back to.
    it('cuts the padding back to the size the sealed body gives, before the file is in Downloads', () => {
        const z = zone();
        z.land('tr_5', 'a.bin', 'real bytes\0\0\0\0\0\0');
        writeFileSync(join(z.landing, 'tr_5', LAN_LANDED_IV), 'aXYx');
        const dest = claimLanFile({ fileName: 'a.bin', transferId: 'tr_5', sealedSize: 10, iv: 'aXYx' }, z.landing, z.downloads);
        expect(readFileSync(dest ?? '').toString()).toBe('real bytes');
        expect(existsSync(join(z.landing, 'tr_5'))).toBe(false);
    });

    // The record's iv and transferId are the relay's word. The size comes from the
    // sealed message by that iv, so it cuts only the file that landed under it.
    it('refuses a size that belongs to another file than the one that landed, and keeps the file', () => {
        const z = zone();
        z.land('tr_7', 'a.bin', 'real bytes');
        writeFileSync(join(z.landing, 'tr_7', LAN_LANDED_IV), 'aXYx');
        expect(() => claimLanFile({ fileName: 'a.bin', transferId: 'tr_7', sealedSize: 2, iv: 'aXYy' }, z.landing, z.downloads)).toThrow(/another file/);
        expect(() => claimLanFile({ fileName: 'a.bin', transferId: 'tr_7', sealedSize: 2 }, z.landing, z.downloads)).toThrow(/another file/);
        expect(readFileSync(join(z.landing, 'tr_7', 'a.bin')).toString()).toBe('real bytes');
        expect(readdirSync(z.downloads)).toEqual([]);
    });

    it('cuts nothing from a file that landed with no iv beside it (a receiver from before this)', () => {
        const z = zone();
        z.land('tr_8', 'a.bin', 'real bytes');
        const dest = claimLanFile({ fileName: 'a.bin', transferId: 'tr_8', sealedSize: 2, iv: 'aXYx' }, z.landing, z.downloads);
        expect(readFileSync(dest ?? '').toString()).toBe('real bytes');
    });

    it('never makes a file longer: a size past the bytes that arrived changes nothing', () => {
        const z = zone();
        z.land('tr_6', 'a.bin', 'real bytes');
        writeFileSync(join(z.landing, 'tr_6', LAN_LANDED_IV), 'aXYx');
        const dest = claimLanFile({ fileName: 'a.bin', transferId: 'tr_6', sealedSize: 4096, iv: 'aXYx' }, z.landing, z.downloads);
        expect(readFileSync(dest ?? '').toString()).toBe('real bytes');
    });

    it('looks the file up by the same safe name the receiver wrote it under', () => {
        const z = zone();
        z.land('tr_3', 'escape.txt', 'E');   // what the receiver stored for '../../escape.txt'
        const dest = claimLanFile({ fileName: '../../escape.txt', transferId: 'tr_3' }, z.landing, z.downloads);
        expect(dest).toBe(join(z.downloads, 'escape.txt'));
    });

    it('null when the transfer is not there; a malformed transferId cannot name a path', () => {
        const z = zone();
        expect(claimLanFile({ fileName: 'a', transferId: 'tr_none' }, z.landing, z.downloads)).toBeNull();
        expect(() => claimLanFile({ fileName: 'a', transferId: '../x' }, z.landing, z.downloads)).toThrow(/malformed transferId/);
    });
});

describe('gcAttachments — landing zone', () => {
    it('sweeps old lan/<transferId> dirs but keeps the zone and young transfers', () => {
        const root = mkdtempSync(join(tmpdir(), 'hwip-att-'));
        const lan = join(root, 'lan');
        mkdirSync(join(lan, 'tr_old'), { recursive: true });
        mkdirSync(join(lan, 'tr_new'), { recursive: true });
        mkdirSync(join(root, 'push_old'), { recursive: true });
        mkdirSync(join(lan, 'lan'), { recursive: true });   // a transfer literally named `lan` is just a transfer
        const now = 10_000_000;
        const ttl = 1_000;
        const old = new Date(now - 5_000);
        utimesSync(join(lan, 'tr_old'), old, old);
        utimesSync(join(root, 'push_old'), old, old);
        utimesSync(lan, old, old);                     // the zone itself is old, must survive
        utimesSync(join(lan, 'lan'), old, old);
        utimesSync(join(lan, 'tr_new'), new Date(now), new Date(now));
        expect(gcAttachments(now, root, ttl, lan)).toBe(3);   // push_old + lan/tr_old + lan/lan
        expect(existsSync(join(lan, 'tr_old'))).toBe(false);
        expect(existsSync(join(lan, 'lan'))).toBe(false);
        expect(existsSync(join(lan, 'tr_new'))).toBe(true);
        expect(existsSync(lan)).toBe(true);              // the zone survives even when it is old itself
        expect(existsSync(join(root, 'push_old'))).toBe(false);
    });
});

describe('handlePush — lanDeliveredTo', () => {
    const deps = (claim: (f: { fileName: string; transferId?: string }) => Promise<string | null>) => {
        const notes: { title: string; body: string; reveal?: string }[] = [];
        return {
            notes,
            deps: {
                deviceId: () => 'dev_me',
                claimLanFile: claim,
                saveFile: async () => { throw new Error('S3 must not be touched for a LAN file'); },
                notify: async (n: { title: string; body: string; reveal?: string }) => { notes.push(n); return true; },
            },
        };
    };
    const push = (lanDeliveredTo: string) => ({
        pushId: 'p', type: 'file', title: '[app] big.mov', senderDeviceId: 'dev_mcp', targetDeviceId: 'dev_me',
        files: [{ fileName: 'big.mov', lanDeliveredTo, transferId: 'tr_9' }],
    });

    it('delivered to this device: claims it, banner, true', async () => {
        const d = deps(async (f) => `/home/u/Downloads/Hwip/${f.fileName}`);
        expect(await handlePush(push('dev_me'), d.deps)).toBe(true);
        // The banner says where the file is and a click can take you there:
        // the title is the name it was saved under, the body the folder.
        expect(d.notes).toEqual([{
            title: 'Hwip · big.mov',
            body: `from [app] big.mov · ${displayFolder('/home/u/Downloads/Hwip/big.mov')}`,
            reveal: '/home/u/Downloads/Hwip/big.mov',
        }]);
    });

    it('not in the landing zone (orphan swept, or duplicated push.new): logged, no banner, false', async () => {
        const d = deps(async () => null);
        expect(await handlePush(push('dev_me'), d.deps)).toBe(false);
        expect(d.notes).toEqual([]);
    });

    it('delivered to another device: nothing claimed, false', async () => {
        let claimed = false;
        const d = deps(async () => { claimed = true; return null; });
        expect(await handlePush({ ...push('dev_other'), targetDeviceId: undefined }, d.deps)).toBe(false);
        expect(claimed).toBe(false);
    });

    it('a claim that throws is logged and does not fail the push handler', async () => {
        const d = deps(async () => { throw new Error('EACCES'); });
        await expect(handlePush(push('dev_me'), d.deps)).resolves.toBe(false);
    });
});

describe('handlePush — what the sealed body says about a file', () => {
    const IV = 'AAECAwQFBg==';
    let mine = '';
    beforeAll(async () => {
        await initDeviceCrypto();
        mine = getDevicePublicKey() ?? '';
    });
    const sealedPush = (file: object) => {
        const phone = v2Party();
        const sealed = phone.sealPush({ title: 'clip', files: [{ iv: IV, name: 'clip.mov', type: 'video/quicktime', size: 9, chunk: 1_048_576 }] }, mine);
        return {
            pushId: 'p', type: 'file', isEncrypted: true, senderDeviceId: 'dev_phone', senderPublicKey: phone.publicKey, targetDeviceId: 'dev_me',
            body: sealed.body, deviceKeyMap: { dev_me: sealed.entry },
            files: [{ fileName: 'file', iv: IV, ...file }],
        };
    };

    it('hands the chunk and the real size to the save of a file from the relay', async () => {
        const saves: unknown[][] = [];
        const push = sealedPush({ fileKey: 'fk', deviceKeyMap: { dev_me: '{}' } });
        expect(await handlePush(push, {
            deviceId: () => 'dev_me',
            saveFile: async (_push, file, sealedSize, chunk) => { saves.push([file.fileName, sealedSize, chunk]); return '/d/clip.mov'; },
            notify: async () => true,
        })).toBe(true);
        expect(saves).toEqual([['clip.mov', 9, 1_048_576]]);
    });

    it('hands the real name and size to the claim of a file that came over the LAN', async () => {
        const claims: unknown[][] = [];
        const push = sealedPush({ lanDeliveredTo: 'dev_me', transferId: 'tr_9' });
        expect(await handlePush(push, {
            deviceId: () => 'dev_me',
            claimLanFile: async (file, sealedSize) => { claims.push([file.fileName, file.iv, sealedSize]); return '/d/clip.mov'; },
            saveFile: async () => { throw new Error('S3 must not be touched for a LAN file'); },
            notify: async () => true,
        })).toBe(true);
        expect(claims).toEqual([['clip.mov', IV, 9]]);
    });
});

describe('displayFolder', () => {
    it('shows the home prefix as ~', () => {
        expect(displayFolder('/Users/me/Downloads/Hwip/a (2).txt', '/Users/me')).toBe('~/Downloads/Hwip');
    });

    it('leaves a folder outside home, or one that only shares its prefix, as it is', () => {
        expect(displayFolder('/Volumes/x/a.txt', '/Users/me')).toBe('/Volumes/x');
        expect(displayFolder('/Users/meg/a.txt', '/Users/me')).toBe('/Users/meg');
    });
});
