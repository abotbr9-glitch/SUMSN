const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, test } = require('node:test');
const express = require('express');

const projectDir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(projectDir, 'server.js'), 'utf8');
const publicDir = path.join(projectDir, 'public');
const homepage = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

// Run only the real HTTP/static routing preamble. Never initialize the
// database, payment gateways, email transport, or shipping provider in tests.
const preambleEnd = source.indexOf('/*');
assert.ok(preambleEnd > 0);
const context = {
    __dirname: projectDir,
    module: { exports: {} },
    sameOriginRequest(req) {
        return !req.headers.origin;
    },
    require(name) {
        if (name === 'express') return express;
        if (name === 'dotenv') return { config() {} };
        if (name.startsWith('node:') || name === 'crypto') return require(name);
        return {};
    }
};
vm.runInNewContext(
    `${source.slice(0, preambleEnd)}\nmodule.exports = app;`,
    context,
    { filename: 'server.js' }
);
const app = context.module.exports;
app.post('/api/routing-test', (req, res) => res.json(req.body));
app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
        res.status(413).json({ success: false });
        return;
    }

    next(error);
});

let server;
let baseUrl;
before(async () => {
    server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

for (const query of ['', '?account=login', '?resetToken=test%2Btoken%2Fvalue%3D&account=reset', '?next=https%3A%2F%2Fexample.com&tag=one&tag=two']) {
    test(`legacy homepage permanently redirects and preserves query: ${query || '(none)'}`, async () => {
        const response = await fetch(`${baseUrl}/index.html${query}`, { redirect: 'manual' });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get('location'), `/${query}`);
    });

    test(`canonical homepage serves the original HTML without a redirect: ${query || '(none)'}`, async () => {
        const response = await fetch(`${baseUrl}/${query}`, { redirect: 'manual' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('location'), null);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(await response.text(), homepage);
    });
}

test('following the legacy URL ends at the root in one redirect', async () => {
    const response = await fetch(`${baseUrl}/index.html?account=login`);
    assert.equal(response.status, 200);
    assert.equal(response.url, `${baseUrl}/?account=login`);
    assert.equal(await response.text(), homepage);
});

test('HEAD requests receive the same permanent redirect', async () => {
    const response = await fetch(`${baseUrl}/index.html?account=login`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), '/?account=login');
    assert.equal(await response.text(), '');
});

for (const file of ['robots.txt', 'sitemap.xml', 'privacy-policy.html', 'terms-and-conditions.html', 'refund-policy.html']) {
    test(`existing static page is unchanged: ${file}`, async () => {
        const response = await fetch(`${baseUrl}/${file}`, { redirect: 'manual' });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), fs.readFileSync(path.join(publicDir, file), 'utf8'));
    });
}

test('API POST requests are not intercepted by homepage routing', async () => {
    const payload = { routingTest: true };
    const response = await fetch(`${baseUrl}/api/routing-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'manual'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
});

test('cross-site browser writes are rejected', async () => {
    const response = await fetch(`${baseUrl}/api/routing-test`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'https://attacker.example'
        },
        body: JSON.stringify({ routingTest: true })
    });

    assert.equal(response.status, 403);
});

test('security headers protect every response and Express is not advertised', async () => {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });

    assert.match(
        response.headers.get('content-security-policy'),
        /frame-ancestors 'none'/
    );
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
        response.headers.get('referrer-policy'),
        'strict-origin-when-cross-origin'
    );
    assert.equal(
        response.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains'
    );
    assert.equal(response.headers.get('x-powered-by'), null);
});

test('oversized JSON bodies are rejected before reaching an API route', async () => {
    const response = await fetch(`${baseUrl}/api/routing-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(70 * 1024) })
    });

    assert.equal(response.status, 413);
});

test('Vercel routes only the homepage and leaves APIs and other pages alone', () => {
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, 'vercel.json'), 'utf8'));
    assert.deepEqual(config.redirects[1], {
        source: '/index.html',
        destination: '/',
        permanent: true
    });
    assert.equal(config.redirects[0].has[0].value, 'www.sumsn.com');
    assert.equal(config.redirects[0].destination, 'https://sumsn.com/:path*');
    assert.deepEqual(config.rewrites, [{ source: '/', destination: '/index.html' }]);
    assert.ok(config.headers[0].headers.some(header =>
        header.key === 'Content-Security-Policy' &&
        header.value.includes("frame-ancestors 'none'")
    ));
    assert.equal(config.cleanUrls, undefined);
});

test('password-reset emails use the canonical homepage URL', () => {
    assert.ok(source.includes('`${PUBLIC_BASE_URL}/?resetToken=${encodeURIComponent(token)}`'));
    assert.ok(!source.includes('`${PUBLIC_BASE_URL}/index.html?resetToken='));
    assert.ok(homepage.includes('<link rel="canonical" href="https://sumsn.com/">'));
});
