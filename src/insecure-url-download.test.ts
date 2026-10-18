/**
 * downloadUrlProblem (src/insecure-url.ts): a relay that rewrites GET /files
 * picks where this machine sends a GET, so only S3 over https — or loopback
 * when the API itself is loopback (local server + LocalStack) — may be fetched.
 */
import { describe, expect, it } from 'vitest';
import { downloadUrlProblem } from './insecure-url.js';

describe('downloadUrlProblem', () => {
    it.each([
        ['https://bucket.s3.amazonaws.com/key', 'https://api.hwip.app'],
        ['https://bucket.s3.us-east-1.amazonaws.com/key', 'https://api.hwip.app'],
        ['https://amazonaws.com/key', 'https://api.hwip.app'],
    ])('allows S3 over https: %s', (url, baseUrl) => {
        expect(downloadUrlProblem(url, baseUrl)).toBeNull();
    });

    it.each([
        ['http://127.0.0.1:4566/key', 'http://127.0.0.1:3000'],
        ['https://localhost:4566/key', 'http://localhost:3000'],
    ])('allows loopback only when the API is loopback too: %s', (url, baseUrl) => {
        expect(downloadUrlProblem(url, baseUrl)).toBeNull();
    });

    it.each([
        ['loopback file against the remote API', 'http://127.0.0.1:4566/key', 'https://api.hwip.app', /is not an S3 download address/],
        ['S3 over plain http (key in the clear)', 'http://bucket.s3.amazonaws.com/key', 'https://api.hwip.app', /is not an S3 download address/],
        ['cloud metadata', 'http://169.254.169.254/latest/meta-data/', 'https://api.hwip.app', /is not an S3 download address/],
        ['LAN host', 'https://192.168.1.10/key', 'https://api.hwip.app', /is not an S3 download address/],
        ['plain https non-S3 host', 'https://evil.example.com/key', 'https://api.hwip.app', /is not an S3 download address/],
        ['suffix confusion', 'https://evil.amazonaws.com.evil.com/key', 'https://api.hwip.app', /is not an S3 download address/],
        ['non-http scheme', 'file:///etc/passwd', 'https://api.hwip.app', /is not an S3 download address/],
        ['https loopback file against the remote API', 'https://localhost:4566/key', 'https://api.hwip.app', /is not an S3 download address/],
        ['not a URL at all', 'not-a-url', 'https://api.hwip.app', /^not a URL$/],
        ['loopback file with an unreadable base URL', 'http://127.0.0.1:4566/key', 'not-a-url', /is not an S3 download address/],
    ])('refuses %s', (_label, url, baseUrl, message) => {
        expect(downloadUrlProblem(url, baseUrl)).toMatch(message);
    });
});
