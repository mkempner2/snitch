const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadConfig,
  createApp,
  sniffImage,
  buildReport,
  sanitizeNote,
  photosFromBuffers,
  canonRecipients,
} = require('../server');

function jpeg(size) {
  const buf = Buffer.alloc(size || 32);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  return buf;
}

function png() {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

function gif() {
  const buf = Buffer.alloc(16);
  buf.write('GIF89a', 0, 'ascii');
  return buf;
}

function webp() {
  const buf = Buffer.alloc(16);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  return buf;
}

function heic() {
  const buf = Buffer.alloc(16);
  buf.write('ftyp', 4, 'ascii');
  buf.write('heic', 8, 'ascii');
  return buf;
}

function fakeCtx(sent, overrides) {
  const config = Object.assign({
    port: 0,
    gmailUser: 'reports@example.com',
    gmailPass: 'abcdefghijklmnop',
    recipients: ['board@example.com'],
    timeZone: 'UTC',
    maxPhotos: 6,
    maxTotalMb: 15,
    maxTotalBytes: 15 * 1024 * 1024,
    noteMax: 4000,
    rateLimitMax: 30,
    rateLimitWindowMs: 60 * 60 * 1000,
    dailySendMax: 100,
    accessCode: '',
    inboundSecret: '',
    trustProxy: false,
    mailMode: 'smtp',
    smtpPort: 587,
    appsScriptUrl: '',
    appsScriptSecret: '',
    jsonLimit: '2mb',
  }, overrides);
  return {
    config,
    runtime: {
      inFlight: 0,
      hits: new Map(),
      sentToday: [],
      mailReady: true,
      lastCheck: 0,
    },
    mailer: {
      async check() {},
      async send(message) { sent.push(message); },
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: method || 'GET',
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function multipart(fields, files) {
  const boundary = '----SnitchBoundary7f3a9c';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const file of files || []) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      Accept: 'application/json',
      Connection: 'close',
    },
  };
}

function withEnv(extra, fn) {
  const keys = [
    'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'HOA_EMAIL', 'PORT', 'MAIL_MODE',
    'ACCESS_CODE', 'INBOUND_SECRET', 'REPORT_TIMEZONE', 'APPS_SCRIPT_URL',
    'APPS_SCRIPT_SECRET', 'MAX_PHOTOS', 'SMTP_PORT', 'TRUST_PROXY', 'RENDER',
  ];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, extra);
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('sniffImage accepts the photo types Snitch documents', () => {
  assert.equal(sniffImage(jpeg()).contentType, 'image/jpeg');
  assert.equal(sniffImage(png()).ext, 'png');
  assert.equal(sniffImage(gif()).ext, 'gif');
  assert.equal(sniffImage(webp()).ext, 'webp');
  assert.equal(sniffImage(heic()).contentType, 'image/heic');
  assert.equal(sniffImage(Buffer.from('%PDF-1.7\nhello world')), null);
  assert.equal(sniffImage(Buffer.from('not a photo!!')), null);
});

test('buildReport uses the HOA cover letter and a dated subject', () => {
  const report = buildReport({
    note: 'Light out on Elm',
    photoCount: 2,
    source: 'web',
    fromLabel: '',
    timeZone: 'UTC',
    now: new Date('2026-10-25T15:04:00Z'),
  });
  assert.match(report.subject, /^Community Deficiency Report – October 25, 2026, /);
  assert.match(report.subject, /3:04/);
  assert.match(report.subject, /Light out on Elm$/);
  assert.match(report.text, /^Dear HOA Management,/);
  assert.match(report.text, /responsibility of the HOA\./);
  assert.match(report.text, /Resident's note:\nLight out on Elm/);
  assert.match(report.text, /Please see the attached photo\(s\) documenting the issue\./);
  assert.match(report.text, /Thank you\./);
  assert.match(report.text, /via the web form/);
  assert.match(report.text, /Photos attached: 2/);
});

test('a text report does not claim photos were attached', () => {
  const report = buildReport({
    note: 'Light out on Elm',
    photoCount: 0,
    source: 'sms',
    fromLabel: '+15551212\nBcc: someone',
    timeZone: 'UTC',
    now: new Date('2026-10-25T15:04:00Z'),
  });
  assert.match(report.text, /Resident's note:\nLight out on Elm/);
  assert.match(report.text, /No photo was attached to this report\./);
  assert.match(report.text, /via text message/);
  assert.match(report.text, /Sender: \+15551212 Bcc: someone\./);
  assert.doesNotMatch(report.text, /Please see the attached photo/);
});

test('sanitizeNote drops control characters and rejects a novel', () => {
  assert.equal(sanitizeNote('Gate\u0000 is open', 100).text, 'Gate is open');
  assert.equal(sanitizeNote('  hello \r\nthere  ', 100).text, 'hello \nthere');
  assert.match(sanitizeNote('x'.repeat(50), 20).error, /too long/);
});

test('photosFromBuffers names safe attachments and rejects other files', () => {
  const ok = photosFromBuffers(
    [{ buffer: jpeg(), originalname: 'front gate.jpg' }],
    { maxPhotos: 6, maxTotalMb: 15, maxTotalBytes: 1024 },
  );
  assert.equal(ok.attachments[0].filename, '01-front-gate.jpg');
  assert.equal(ok.attachments[0].contentType, 'image/jpeg');

  const bad = photosFromBuffers(
    [{ buffer: Buffer.from('%PDF-1.7 document'), originalname: 'invoice.pdf' }],
    { maxPhotos: 6, maxTotalMb: 15, maxTotalBytes: 1024 },
  );
  assert.match(bad.error, /invoice\.pdf/);
});

test('loadConfig strips app-password spaces and checks the recipient', () => {
  withEnv({
    GMAIL_USER: 'reports@example.com',
    GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
    HOA_EMAIL: 'Desk@Example.com, board@example.com',
    REPORT_TIMEZONE: 'America/Chicago',
  }, () => {
    const { errors, config } = loadConfig();
    assert.deepEqual(errors, []);
    assert.equal(config.gmailPass, 'abcdefghijklmnop');
    assert.equal(config.timeZone, 'America/Chicago');
    assert.equal(
      canonRecipients(config.recipients.join(',')),
      'board@example.com,desk@example.com',
    );
  });

  withEnv({}, () => {
    const { errors } = loadConfig();
    assert.ok(errors.some((error) => error.includes('HOA_EMAIL')));
    assert.ok(errors.some((error) => error.includes('GMAIL_APP_PASSWORD')));
  });

  withEnv({
    MAIL_MODE: 'apps-script',
    HOA_EMAIL: 'board@example.com',
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/abc/exec',
    APPS_SCRIPT_SECRET: '0123456789abcdef',
  }, () => {
    const { errors, config } = loadConfig();
    assert.deepEqual(errors, []);
    assert.equal(config.mailMode, 'apps-script');
  });
});

test('the home page and health check are served', async (t) => {
  const { server, port } = await listen(createApp(fakeCtx([])));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const home = await request({ port, path: '/', headers: { Accept: 'text/html', Connection: 'close' } });
  assert.equal(home.status, 200);
  assert.match(home.body, /Report it to the HOA/);
  const health = await request({ port, path: '/health', headers: { Connection: 'close' } });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).mail, true);
  const config = await request({ port, path: '/api/config', headers: { Connection: 'close' } });
  const body = JSON.parse(config.body);
  assert.equal(body.requireAccessCode, false);
  assert.equal(body.maxTotalMb, 15);
});

test('the web form emails a photo and refuses anything else', async (t) => {
  const sent = [];
  const { server, port } = await listen(createApp(fakeCtx(sent)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const empty = multipart({ note: 'Broken gate' }, []);
  const missing = await request({ port, method: 'POST', path: '/api/report', ...empty });
  assert.equal(missing.status, 400);
  assert.match(missing.body, /at least one photo/);
  assert.equal(sent.length, 0);

  const pdf = multipart({ note: '' }, [{ filename: 'invoice.pdf', buffer: Buffer.from('%PDF-1.7 not a photo') }]);
  const rejected = await request({ port, method: 'POST', path: '/api/report', ...pdf });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /invoice\.pdf/);

  const photo = multipart(
    { note: 'Latch is broken', accessCode: '', snitch_hp: '' },
    [{ filename: 'gate.jpg', buffer: jpeg() }],
  );
  const ok = await request({ port, method: 'POST', path: '/api/report', ...photo });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^Community Deficiency Report – /);
  assert.match(sent[0].subject, /Latch is broken/);
  assert.match(sent[0].text, /Latch is broken/);
  assert.match(sent[0].text, /Please see the attached photo\(s\)/);
  assert.equal(sent[0].attachments[0].filename, '01-gate.jpg');
  assert.equal(sent[0].attachments[0].contentType, 'image/jpeg');

  const browser = multipart({ note: 'From a phone' }, [{ filename: 'yard.png', buffer: png() }]);
  browser.headers.Accept = 'text/html';
  const redirected = await request({ port, method: 'POST', path: '/api/report', ...browser });
  assert.equal(redirected.status, 303);
  assert.equal(redirected.headers.location, '/success.html');
});

test('a filled honeypot looks successful and sends nothing', async (t) => {
  const sent = [];
  const { server, port } = await listen(createApp(fakeCtx(sent)));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const body = multipart(
    { note: 'buy followers', snitch_hp: 'https://spam.example' },
    [{ filename: 'a.jpg', buffer: jpeg() }],
  );
  const response = await request({ port, method: 'POST', path: '/api/report', ...body });
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0);
});

test('the community code is required only when it is configured', async (t) => {
  const sent = [];
  const { server, port } = await listen(createApp(fakeCtx(sent, { accessCode: 'maple-court' })));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const wrong = multipart(
    { note: '', accessCode: 'nope' },
    [{ filename: 'a.jpg', buffer: jpeg() }],
  );
  const denied = await request({ port, method: 'POST', path: '/api/report', ...wrong });
  assert.equal(denied.status, 403);
  const right = multipart(
    { note: 'Pool light', accessCode: 'maple-court' },
    [{ filename: 'a.jpg', buffer: jpeg() }],
  );
  const allowed = await request({ port, method: 'POST', path: '/api/report', ...right });
  assert.equal(allowed.status, 200);
  assert.equal(sent.length, 1);
});

test('inbound intake stays off until a secret is set, then accepts a text', async (t) => {
  const closed = [];
  const off = await listen(createApp(fakeCtx(closed)));
  t.after(() => new Promise((resolve) => off.server.close(resolve)));
  const disabled = await request({
    port: off.port,
    method: 'POST',
    path: '/api/inbound',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Connection: 'close' },
    body: JSON.stringify({ note: 'hello' }),
  });
  assert.equal(disabled.status, 404);

  const sent = [];
  const on = await listen(createApp(fakeCtx(sent, { inboundSecret: '0123456789abcdef' })));
  t.after(() => new Promise((resolve) => on.server.close(resolve)));

  const unauthorized = await request({
    port: on.port,
    method: 'POST',
    path: '/api/inbound/sms',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Connection: 'close' },
    body: JSON.stringify({ secret: 'nope', content: 'Light out' }),
  });
  assert.equal(unauthorized.status, 401);

  const sms = await request({
    port: on.port,
    method: 'POST',
    path: '/api/inbound/sms?secret=0123456789abcdef',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Connection: 'close',
    },
    body: 'from=%2B15551212&content=Light+out+on+Elm',
  });
  assert.equal(sms.status, 200);
  assert.match(sent[0].text, /Light out on Elm/);
  assert.match(sent[0].text, /No photo was attached/);
  assert.match(sent[0].text, /Sender: \+15551212/);
  assert.equal(sent[0].attachments.length, 0);

  const loop = await request({
    port: on.port,
    method: 'POST',
    path: '/api/inbound',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer 0123456789abcdef',
      Accept: 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify({
      subject: 'Community Deficiency Report – October 25, 2026',
      note: 'again',
    }),
  });
  assert.equal(loop.status, 400);

  const withPhoto = await request({
    port: on.port,
    method: 'POST',
    path: '/api/inbound',
    headers: {
      'Content-Type': 'application/json',
      'X-Inbound-Secret': '0123456789abcdef',
      Accept: 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify({
      source: 'email',
      from: 'Neighbor <neighbor@example.com>',
      note: 'See the fence',
      images: [{ filename: 'fence.heic', data: heic().toString('base64') }],
    }),
  });
  assert.equal(withPhoto.status, 200);
  assert.equal(sent[1].attachments[0].contentType, 'image/heic');
  assert.match(sent[1].text, /via email/);
});
