import { describe, expect, it } from 'vitest';
import { callbackAddressProblem, parseAllowHosts, trustedCallbackHosts } from './login-address.js';

describe('parseAllowHosts (--allow-host, C132)', () => {
    it('is no hosts when the flag is not given', () => {
        expect(parseAllowHosts(undefined)).toEqual({ hosts: [] });
    });

    it('reads one host or a comma-separated list, lower-cased and without a trailing dot', () => {
        expect(parseAllowHosts('api.example.com')).toEqual({ hosts: ['api.example.com'] });
        expect(parseAllowHosts(' A.Example.com. , 10.0.0.5 ,b-c.example.org')).toEqual({
            hosts: ['a.example.com', '10.0.0.5', 'b-c.example.org'],
        });
    });

    it.each([
        ['a bare flag', true],
        ['empty', ''],
        ['an empty entry', 'a.example,'],
        ['a scheme', 'https://api.example.com'],
        ['a port', 'api.example.com:8443'],
        ['a path', 'api.example.com/v1'],
        ['userinfo', 'user@api.example.com'],
        ['a wildcard', '*.example.com'],
        ['one label, which would trust a whole top-level domain', 'com'],
        ['a leading dot', '.example.com'],
        ['a space inside', 'api example.com'],
    ])('refuses %s', (_name, value) => {
        expect(parseAllowHosts(value)).toHaveProperty('error');
    });

    it('names the offending entry, not the rest of the list', () => {
        const parsed = parseAllowHosts('ok.example.com,https://bad.example.com');
        expect(parsed).toEqual({ error: expect.stringContaining('"https://bad.example.com"') });
        expect(JSON.stringify(parsed)).not.toContain('ok.example.com');
    });

    it('is what callbackAddressProblem takes as extra hosts', () => {
        const hosts = (parseAllowHosts('mine.example') as { hosts: string[] }).hosts;
        expect(callbackAddressProblem('baseUrl', 'https://api.mine.example/v1', hosts)).toBeNull();
        expect(callbackAddressProblem('baseUrl', 'https://api.mine.example/v1')).toMatch(/is not one hwip knows/);
    });
});

describe('parseAllowHosts: IP addresses', () => {
    it('takes a whole IPv4 address, and no part of one', () => {
        expect(parseAllowHosts('192.168.1.20')).toEqual({ hosts: ['192.168.1.20'] });
        for (const part of ['0.5', '10.0.0', '1.2.3.4.5']) expect(parseAllowHosts(part)).toHaveProperty('error');
    });

    it('never reads an IP entry as a suffix, even one parseAllowHosts would refuse', () => {
        expect(callbackAddressProblem('baseUrl', 'https://192.168.1.20/v1', ['192.168.1.20'])).toBeNull();
        expect(callbackAddressProblem('baseUrl', 'https://10.0.0.5/v1', ['0.5'])).toMatch(/is not one hwip knows/);
    });
});

describe('trustedCallbackHosts (login callback trust, C131)', () => {
    it('names the console host plus the hosts config.json already holds', () => {
        expect(trustedCallbackHosts('https://console.hwip.app/', {
            baseUrl: 'https://api.example.com/v1', wsUrl: 'wss://ws.example.com',
        })).toEqual(['console.hwip.app', 'api.example.com', 'ws.example.com']);
    });

    it('drops what is missing, relative, or not a string', () => {
        expect(trustedCallbackHosts('https://console.hwip.app/', {})).toEqual(['console.hwip.app']);
        expect(trustedCallbackHosts('not-a-url', { baseUrl: '/relative', wsUrl: 42 })).toEqual([]);
    });

    it('normalises case and a trailing dot, and drops empties', () => {
        expect(trustedCallbackHosts('https://Console.Hwip.App./', { baseUrl: 'https://API.Example.COM./v1' })).toEqual([
            'console.hwip.app', 'api.example.com',
        ]);
        expect(trustedCallbackHosts('file:///etc/passwd', {})).toEqual([]);
    });
});
