/**
 * Snitch — a small site that emails HOA deficiency reports.
 *
 * Photos stay in memory (Multer memoryStorage) and are attached to one
 * Gmail message. Nothing is written to disk, which matters on free hosts
 * whose disks disappear on restart.
 *
 * Default mail path: Gmail SMTP on port 587 with an app password.
 * Some free hosts block that port. Set MAIL_MODE=apps-script to hand the
 * same message to a Google Apps Script over HTTPS instead. See README.md.
 */

const crypto = require('crypto');
const path = require('path');

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
require('dotenv').config();

const PUBLIC_DIR = path.join(__dirname, 'public');
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx',
  'heim', 'heis', 'hevm', 'hevs',
  'heif', 'mif1', 'msf1',
]);
const NOTE_KEYS = ['note', 'text', 'body', 'message', 'content', 'sms', 'msg'];
const FROM_KEYS = ['from', 'sender', 'phone', 'fromNumber'];
const INBOUND_FILE_FIELDS = new Set([
  'photos', 'photo', 'images', 'image', 'file', 'files', 'attachment', 'attachments',
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseRecipients(value) {
  const list = String(value || '')
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!list.length || list.some((email) => !isEmail(email))) return null;
  return list;
}

function canonRecipients(value) {
  const list = parseRecipients(value);
  if (!list) return null;
  return list.map((email) => email.toLowerCase()).sort().join(',');
}

function readInteger(name, fallback, min, max, errors) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}.`);
    return fallback;
  }
  return value;
}

function validTimeZone(value) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function loadConfig() {
  const errors = [];
  const mailMode = (process.env.MAIL_MODE || 'smtp').trim().toLowerCase();
  if (mailMode !== 'smtp' && mailMode !== 'apps-script') {
    errors.push('MAIL_MODE must be smtp or apps-script.');
  }

  const recipients = parseRecipients(process.env.HOA_EMAIL);
  if (!recipients) errors.push('HOA_EMAIL must be one or more email addresses, separated by commas.');
  else if (recipients.length > 10) errors.push('HOA_EMAIL can list at most 10 addresses.');

  const gmailUser = (process.env.GMAIL_USER || '').trim();
  const gmailPass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const appsScriptUrl = (process.env.APPS_SCRIPT_URL || '').trim();
  const appsScriptSecret = (process.env.APPS_SCRIPT_SECRET || '').trim();

  if (mailMode === 'smtp') {
    if (!isEmail(gmailUser)) errors.push('GMAIL_USER must be the Gmail address that sends reports.');
    if (gmailPass.length < 8) {
      errors.push('GMAIL_APP_PASSWORD is missing. Create a Gmail app password (2-Step Verification required).');
    }
  } else if (mailMode === 'apps-script') {
    if (!/^https:\/\//i.test(appsScriptUrl)) errors.push('APPS_SCRIPT_URL must be the https URL of the relay web app.');
    if (appsScriptSecret.length < 16) errors.push('APPS_SCRIPT_SECRET must be at least 16 characters.');
  }

  const accessCode = (process.env.ACCESS_CODE || '').trim();
  if (accessCode && accessCode.length < 4) errors.push('ACCESS_CODE must be at least 4 characters, or leave it blank.');

  const inboundSecret = (process.env.INBOUND_SECRET || '').trim();
  if (inboundSecret && inboundSecret.length < 16) {
    errors.push('INBOUND_SECRET must be at least 16 characters, or leave it blank to disable intake.');
  }

  let timeZone = (process.env.REPORT_TIMEZONE || 'UTC').trim() || 'UTC';
  if (!validTimeZone(timeZone)) {
    errors.push(`REPORT_TIMEZONE "${timeZone}" is not a valid IANA timezone.`);
    timeZone = 'UTC';
  }

  const port = readInteger('PORT', 8000, 1, 65535, errors);
  const maxPhotos = readInteger('MAX_PHOTOS', 6, 1, 10, errors);
  // 15 MB of photos becomes about 20 MB after base64, under Gmail's 25 MB cap.
  const maxTotalMb = readInteger('MAX_TOTAL_MB', 15, 1, 18, errors);
  const noteMax = readInteger('NOTE_MAX_LENGTH', 4000, 200, 10000, errors);
  const rateLimitMax = readInteger('RATE_LIMIT_MAX', 20, 1, 100, errors);
  const rateLimitWindowMin = readInteger('RATE_LIMIT_WINDOW_MIN', 60, 1, 1440, errors);
  const dailySendMax = readInteger('DAILY_SEND_MAX', 100, 1, 500, errors);
  const smtpPort = readInteger('SMTP_PORT', 587, 1, 65535, errors);

  const fromName = cleanHeaderName(process.env.FROM_NAME, 'Community Report');

  const trustRaw = process.env.TRUST_PROXY;
  let trustProxy = false;
  if (trustRaw == null || String(trustRaw).trim() === '') {
    trustProxy = process.env.RENDER === 'true';
  } else {
    trustProxy = /^(1|true|yes|on)$/i.test(String(trustRaw).trim());
  }

  return {
    errors,
    config: {
      port,
      mailMode,
      gmailUser,
      gmailPass,
      fromName,
      recipients: recipients || [],
      timeZone,
      maxPhotos,
      maxTotalMb,
      maxTotalBytes: maxTotalMb * 1024 * 1024,
      noteMax,
      rateLimitMax,
      rateLimitWindowMs: rateLimitWindowMin * 60 * 1000,
      dailySendMax,
      accessCode,
      inboundSecret,
      trustProxy,
      smtpPort,
      appsScriptUrl,
      appsScriptSecret,
      jsonLimit: `${Math.ceil((maxTotalMb * 4) / 3) + 2}mb`,
    },
  };
}

// ---------------------------------------------------------------------------
// Report text and image checks
// ---------------------------------------------------------------------------

function formatWhen(timeZone, now) {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  return { date, time };
}

function sanitizeNote(raw, max) {
  const text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (text.length > max) {
    return { error: `The note is too long. Keep it under ${max} characters.` };
  }
  return { text };
}

function cleanHeaderName(value, fallback) {
  const clean = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
  return clean || fallback;
}

function sanitizeFrom(value) {
  return cleanHeaderName(value, '').slice(0, 160);
}

function subjectExcerpt(note) {
  const line = String(note || '')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line || line === '(no additional note provided)') return '';
  const clean = cleanHeaderName(line, '');
  if (clean.length <= 60) return clean;
  return `${clean.slice(0, 57).trimEnd()}…`;
}

function buildReport({ note, photoCount, source, fromLabel, timeZone, now }) {
  const shown = note && String(note).trim() ? String(note).trim() : '(no additional note provided)';
  // The cover letter promises photos. Text-message intake often has none,
  // so that one sentence changes instead of claiming attachments that are not there.
  const photoLine = photoCount > 0
    ? 'Please see the attached photo(s) documenting the issue.'
    : 'No photo was attached to this report.';
  const when = formatWhen(timeZone, now || new Date());
  const via = source === 'web'
    ? 'the web form'
    : source === 'sms'
      ? 'text message'
      : source === 'email'
        ? 'email'
        : 'an inbound message';
  const sender = fromLabel ? ` Sender: ${sanitizeFrom(fromLabel)}.` : '';
  const text = [
    'Dear HOA Management,',
    '',
    'I am writing to inform you that a fellow resident has noticed a deficiency in our community and requests that it be addressed as quickly as possible, as this is the responsibility of the HOA.',
    '',
    "Resident's note:",
    shown,
    '',
    photoLine,
    '',
    'If you could please respond to this email to acknowledge reception and provide an estimate of when the issue will be resolved, we would greatly appreciate it.',
    '',
    'Thank you.',
    '',
    '—',
    `Submitted ${when.date} at ${when.time} (${timeZone}) via ${via}.${sender}`,
    `Photos attached: ${photoCount}.`,
  ].join('\n');

  // The time and the note keep each subject different. A stack of identical
  // subjects from a new mailbox is what Gmail treats like a mail blast.
  const excerpt = subjectExcerpt(shown);
  const subject = excerpt
    ? `Community Deficiency Report – ${when.date}, ${when.time} – ${excerpt}`
    : `Community Deficiency Report – ${when.date}, ${when.time}`;

  return { subject, text };
}

function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  const head6 = buffer.slice(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  // HEIC/HEIF is an ISO BMFF file. "ftyp" sits at byte 4; the brand follows.
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii').toLowerCase();
    if (HEIC_BRANDS.has(brand)) return { ext: 'heic', contentType: 'image/heic' };
  }
  return null;
}

function displayName(name, index) {
  const base = String(name || `photo ${index + 1}`).split(/[/\\]/).pop();
  const clean = base.replace(/[\r\n\t]/g, ' ').trim().slice(0, 80);
  return clean || `photo ${index + 1}`;
}

function attachmentName(original, ext, index) {
  const base = String(original || '').split(/[/\\]/).pop();
  const stem = base
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${String(index + 1).padStart(2, '0')}-${stem || 'photo'}.${ext}`;
}

function photosFromBuffers(items, limits) {
  if (items.length > limits.maxPhotos) {
    return { error: `You can attach up to ${limits.maxPhotos} photos.` };
  }
  const attachments = [];
  let total = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const name = displayName(item.originalname, i);
    const buffer = item.buffer;
    if (!buffer || !buffer.length) return { error: `${name} is empty.` };
    total += buffer.length;
    if (total > limits.maxTotalBytes) {
      return { error: `Those photos are too large. Keep the total under ${limits.maxTotalMb} MB.` };
    }
    const sniffed = sniffImage(buffer);
    if (!sniffed) {
      return { error: `${name} is not a photo Snitch can send. Use JPG, PNG, GIF, WEBP, or HEIC.` };
    }
    attachments.push({
      filename: attachmentName(item.originalname, sniffed.ext, i),
      content: buffer,
      contentType: sniffed.contentType,
    });
  }
  return { attachments };
}

function estimateBase64Bytes(b64) {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function decodeBase64Image(data, limits) {
  if (typeof data !== 'string' || !data.trim()) {
    return { error: 'Each photo needs to be base64 data.' };
  }
  let b64 = data.trim();
  const dataUrl = b64.match(/^data:[^;,]+;base64,([\s\S]+)$/i);
  if (dataUrl) b64 = dataUrl[1];
  b64 = b64.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'A photo was not valid base64.' };
  if (estimateBase64Bytes(b64) > limits.maxTotalBytes) {
    return { error: `Those photos are too large. Keep the total under ${limits.maxTotalMb} MB.` };
  }
  return { buffer: Buffer.from(b64, 'base64') };
}

function buffersFromJsonImages(images, limits) {
  if (images == null) return { items: [] };
  if (!Array.isArray(images)) return { error: 'Images must be a list.' };
  if (images.length > limits.maxPhotos) {
    return { error: `You can attach up to ${limits.maxPhotos} photos.` };
  }
  const items = [];
  let estimated = 0;
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i] || {};
    const decoded = decodeBase64Image(image.data, limits);
    if (decoded.error) return { error: decoded.error };
    estimated += decoded.buffer.length;
    if (estimated > limits.maxTotalBytes) {
      return { error: `Those photos are too large. Keep the total under ${limits.maxTotalMb} MB.` };
    }
    items.push({
      buffer: decoded.buffer,
      originalname: typeof image.filename === 'string' ? image.filename : `photo-${i + 1}`,
    });
  }
  return { items };
}

function firstText(body, keys) {
  if (!body || typeof body !== 'object') return '';
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function friendlyMailError(err) {
  const message = String((err && err.message) || err || '');
  if (/quota|daily user sending|too many|rate limit exceeded|550 5\.4\.5/i.test(message)) {
    return 'The sending Gmail account has hit its daily limit. Try again tomorrow.';
  }
  if (/invalid login|username and password|535|534|badcredentials|invalid_grant/i.test(message)) {
    return 'Gmail refused the sign-in. Check GMAIL_USER and the app password.';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|Greeting never received|Connection timeout|timed out|ECONNRESET/i.test(message)) {
    return 'Could not reach Gmail. On a free Render or Railway plan, outbound SMTP is blocked. See the README for Koyeb or the Apps Script relay.';
  }
  return 'We could not send the report. Nothing was saved. Please try again in a few minutes.';
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

async function postToAppsScript(url, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'text/plain;charset=utf-8',
    'User-Agent': 'Snitch/1.0',
  };
  // Apps Script web apps answer with a 302. Node's default redirect
  // follower would turn the POST into a GET and drop the body.
  let current = url;
  let response;
  for (let hop = 0; hop < 4; hop += 1) {
    response = await fetch(current, {
      method: 'POST',
      redirect: 'manual',
      headers,
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('Apps Script redirect had no location.');
    current = new URL(location, current).href;
  }
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!response.ok || data.ok !== true) {
    const detail = data.error || text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(detail || `Apps Script returned HTTP ${response.status}.`);
  }
  return data;
}

function createMailer(config) {
  if (config.mailMode === 'apps-script') {
    return {
      async check() {
        await postToAppsScript(config.appsScriptUrl, {
          secret: config.appsScriptSecret,
          ping: true,
        });
      },
      async send({ subject, text, attachments, replyTo }) {
        await postToAppsScript(config.appsScriptUrl, {
          secret: config.appsScriptSecret,
          to: config.recipients.join(', '),
          fromName: config.fromName,
          replyTo: replyTo || '',
          subject,
          text,
          images: attachments.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            data: file.content.toString('base64'),
          })),
        });
      },
    };
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort === 587,
    auth: {
      user: config.gmailUser,
      pass: config.gmailPass,
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });

  return {
    async check() {
      await transporter.verify();
    },
    async send({ subject, text, attachments, replyTo }) {
      await transporter.sendMail({
        from: { name: config.fromName, address: config.gmailUser },
        replyTo: replyTo || config.gmailUser,
        to: config.recipients,
        subject,
        text,
        attachments: attachments.map((file) => ({
          filename: file.filename,
          content: file.content,
          contentType: file.contentType,
          contentDisposition: 'attachment',
        })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wantsJson(req) {
  const accept = (req.get('accept') || '').toLowerCase();
  if (accept.includes('application/json')) return true;
  if (accept.includes('text/html')) return false;
  return req.path.startsWith('/api/');
}

function sendPage(res, status, { heading, message }) {
  const safe = escapeHtml(message);
  const safeHeading = escapeHtml(heading);
  res.status(status).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Eastridge Reports</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="wrap">
    <p class="mark">Eastridge Reports</p>
    <section class="card">
      <h1>${safeHeading}</h1>
      <p class="lede">${safe}</p>
      <a class="send" href="/">Back to the form</a>
    </section>
  </main>
</body>
</html>`);
}

function createApp(ctx) {
  const { config } = ctx;
  if (!ctx.runtime) {
    ctx.runtime = {
      inFlight: 0,
      hits: new Map(),
      sentToday: [],
      mailReady: false,
      lastCheck: 0,
    };
  }
  if (!ctx.runtime.hits) ctx.runtime.hits = new Map();
  if (!ctx.runtime.sentToday) ctx.runtime.sentToday = [];

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    next();
  });

  function sendError(req, res, status, message) {
    if (res.headersSent) return;
    res.set('Cache-Control', 'no-store');
    if (wantsJson(req)) {
      res.status(status).json({ error: message });
      return;
    }
    sendPage(res, status, { heading: 'That report was not sent.', message });
  }

  function sendOk(req, res) {
    res.set('Cache-Control', 'no-store');
    if (wantsJson(req)) {
      res.json({ ok: true });
      return;
    }
    res.redirect(303, '/success.html');
  }

  function asyncRoute(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch((err) => {
        console.error('[snitch] unexpected error:', err);
        sendError(req, res, 500, 'Something went wrong. Please try again.');
      });
    };
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: config.maxPhotos,
      fileSize: config.maxTotalBytes,
      fields: 20,
      parts: config.maxPhotos + 20,
      fieldSize: 64 * 1024,
    },
  }).any();

  function withUpload(req, res, next) {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return sendError(req, res, 413, `Each photo, and the whole report, must stay under ${config.maxTotalMb} MB.`);
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return sendError(req, res, 400, `You can attach up to ${config.maxPhotos} photos.`);
        }
        if (err.code === 'LIMIT_FIELD_VALUE') {
          return sendError(req, res, 400, `The note is too long. Keep it under ${config.noteMax} characters.`);
        }
        return sendError(req, res, 400, 'Could not read those photos. Try smaller images.');
      }
      console.error('[snitch] upload error:', err);
      return sendError(req, res, 400, 'Could not read those photos.');
    });
  }

  function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || 'unknown';
    const recent = (ctx.runtime.hits.get(ip) || []).filter((stamp) => now - stamp < config.rateLimitWindowMs);
    if (recent.length >= config.rateLimitMax) {
      const waitMin = Math.max(1, Math.ceil((config.rateLimitWindowMs - (now - recent[0])) / 60000));
      return sendError(
        req,
        res,
        429,
        `Too many reports from this network. Please wait about ${waitMin} minute${waitMin === 1 ? '' : 's'} and try again.`,
      );
    }
    recent.push(now);
    ctx.runtime.hits.set(ip, recent);
    if (ctx.runtime.hits.size > 2000) {
      for (const [key, times] of ctx.runtime.hits) {
        if (!times.some((stamp) => now - stamp < config.rateLimitWindowMs)) ctx.runtime.hits.delete(key);
      }
    }
    next();
  }

  // A few oversized uploads at once would otherwise sit in RAM together.
  function concurrency(req, res, next) {
    if (ctx.runtime.inFlight >= 3) {
      return sendError(req, res, 429, 'Snitch is sending other reports right now. Wait a minute and try again.');
    }
    ctx.runtime.inFlight += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      ctx.runtime.inFlight -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  }

  function recentSends() {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    ctx.runtime.sentToday = ctx.runtime.sentToday.filter((stamp) => now - stamp < day);
    return ctx.runtime.sentToday;
  }

  async function ensureReady() {
    if (ctx.runtime.mailReady) return true;
    const now = Date.now();
    if (now - ctx.runtime.lastCheck < 60000) return false;
    ctx.runtime.lastCheck = now;
    try {
      await ctx.mailer.check();
      ctx.runtime.mailReady = true;
      console.log('[snitch] mail check ok');
      return true;
    } catch (err) {
      ctx.runtime.mailReady = false;
      console.error('[snitch] mail check failed:', err.message);
      return false;
    }
  }

  async function deliverReport(req, res, { note, attachments, source, fromLabel, replyTo }) {
    if (recentSends().length >= config.dailySendMax) {
      return sendError(req, res, 429, 'Snitch has sent its daily limit of reports. Please try again tomorrow.');
    }
    if (!(await ensureReady())) {
      return sendError(req, res, 503, 'Email is not available right now. Please try again in a few minutes.');
    }
    const report = buildReport({
      note,
      photoCount: attachments.length,
      source,
      fromLabel,
      timeZone: config.timeZone,
    });
    try {
      await ctx.mailer.send({
        subject: report.subject,
        text: report.text,
        attachments,
        replyTo: replyTo || undefined,
      });
    } catch (err) {
      console.error('[snitch] send failed:', err.message);
      ctx.runtime.mailReady = false;
      ctx.runtime.lastCheck = Date.now();
      return sendError(req, res, 502, friendlyMailError(err));
    }
    recentSends().push(Date.now());
    const bytes = attachments.reduce((sum, file) => sum + file.content.length, 0);
    console.log(`[snitch] sent source=${source} photos=${attachments.length} bytes=${bytes}`);
    return sendOk(req, res);
  }

  function accessAllowed(req, res) {
    if (!config.accessCode) return true;
    const given = typeof req.body.accessCode === 'string' ? req.body.accessCode.trim() : '';
    if (!given) {
      sendError(req, res, 403, 'Enter the community code.');
      return false;
    }
    if (!safeEqual(given, config.accessCode)) {
      sendError(req, res, 403, "That community code isn't right.");
      return false;
    }
    return true;
  }

  app.get('/health', (req, res) => {
    res.status(200).json({ ok: true, mail: Boolean(ctx.runtime.mailReady) });
  });

  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      maxPhotos: config.maxPhotos,
      maxTotalMb: config.maxTotalMb,
      noteMax: config.noteMax,
      requireAccessCode: Boolean(config.accessCode),
    });
  });

  app.post('/api/report', rateLimit, concurrency, withUpload, asyncRoute(async (req, res) => {
    if (typeof req.body.snitch_hp === 'string' && req.body.snitch_hp.trim()) {
      console.log('[snitch] dropped a submission that filled the hidden field');
      return sendOk(req, res);
    }
    if (!accessAllowed(req, res)) return;

    const files = (req.files || []).filter((file) => file.fieldname === 'photos');
    const parsed = photosFromBuffers(
      files.map((file) => ({ buffer: file.buffer, originalname: file.originalname })),
      config,
    );
    if (parsed.error) return sendError(req, res, 400, parsed.error);
    if (!parsed.attachments.length) {
      return sendError(req, res, 400, 'Add at least one photo so the HOA can see the issue.');
    }
    const note = sanitizeNote(req.body.note, config.noteMax);
    if (note.error) return sendError(req, res, 400, note.error);

    let replyTo = '';
    let fromLabel = '';
    const rawEmail = typeof req.body.senderEmail === 'string' ? req.body.senderEmail.trim() : '';
    if (rawEmail) {
      if (!isEmail(rawEmail) || rawEmail.length > 120) {
        return sendError(req, res, 400, "That email address doesn't look right. Leave it blank if you prefer.");
      }
      replyTo = rawEmail.toLowerCase();
      fromLabel = replyTo;
    }

    await deliverReport(req, res, {
      note: note.text,
      attachments: parsed.attachments,
      source: 'web',
      fromLabel,
      replyTo,
    });
  }));

  function inboundBody(req, res, next) {
    const type = (req.get('content-type') || '').toLowerCase();
    if (type.includes('multipart/form-data')) return withUpload(req, res, next);
    if (type.includes('application/x-www-form-urlencoded')) {
      return express.urlencoded({ extended: false, limit: '100kb' })(req, res, (err) => {
        if (err) return sendError(req, res, 400, 'Could not read that message.');
        next();
      });
    }
    return express.text({ type: () => true, limit: config.jsonLimit })(req, res, (err) => {
      if (err) return sendError(req, res, 400, 'Could not read that message.');
      const raw = typeof req.body === 'string' ? req.body.trim() : '';
      if (!raw) {
        req.body = {};
        return next();
      }
      if (raw.startsWith('{') || raw.startsWith('[')) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          return sendError(req, res, 400, 'Could not read that message.');
        }
        return next();
      }
      req.body = { note: raw };
      return next();
    });
  }

  function presentedSecret(req) {
    const header = req.get('x-inbound-secret') || '';
    const auth = req.get('authorization') || '';
    const bearer = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
    const query = typeof req.query.secret === 'string' ? req.query.secret : '';
    const bodySecret = req.body && typeof req.body.secret === 'string' ? req.body.secret : '';
    return header || bearer || query || bodySecret;
  }

  function inboundEnabled(req, res, next) {
    if (!config.inboundSecret) {
      return sendError(req, res, 404, 'Inbound intake is not turned on.');
    }
    next();
  }

  function handleInbound(forcedSource) {
    return asyncRoute(async (req, res) => {
      const presented = presentedSecret(req);
      if (!presented || !safeEqual(presented, config.inboundSecret)) {
        return sendError(req, res, 401, 'That inbound secret is not valid.');
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const subject = typeof body.subject === 'string' ? body.subject : '';
      if (/community deficiency report/i.test(subject)) {
        return sendError(req, res, 400, 'This message already looks like a Snitch report, so it was not sent again.');
      }

      let items = [];
      if (Array.isArray(req.files) && req.files.length) {
        items = req.files
          .filter((file) => INBOUND_FILE_FIELDS.has(file.fieldname))
          .map((file) => ({ buffer: file.buffer, originalname: file.originalname }));
      } else if (body.images) {
        const decoded = buffersFromJsonImages(body.images, config);
        if (decoded.error) return sendError(req, res, 400, decoded.error);
        items = decoded.items;
      }

      const parsed = photosFromBuffers(items, config);
      if (parsed.error) return sendError(req, res, 400, parsed.error);

      const note = sanitizeNote(firstText(body, NOTE_KEYS), config.noteMax);
      if (note.error) return sendError(req, res, 400, note.error);
      if (!note.text && !parsed.attachments.length) {
        return sendError(req, res, 400, 'Send a note, a photo, or both.');
      }

      const source = forcedSource || normalizeSource(body.source);
      await deliverReport(req, res, {
        note: note.text,
        attachments: parsed.attachments,
        source,
        fromLabel: sanitizeFrom(firstText(body, FROM_KEYS)),
      });
    });
  }

  app.post('/api/inbound', inboundEnabled, rateLimit, concurrency, inboundBody, handleInbound());
  app.post('/api/inbound/sms', inboundEnabled, rateLimit, concurrency, inboundBody, handleInbound('sms'));

  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html') || filePath.endsWith('robots.txt')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.use((req, res) => {
    sendError(req, res, 404, 'That page is not here.');
  });

  return app;
}

function normalizeSource(value) {
  const source = String(value || '').toLowerCase().trim();
  if (source === 'sms' || source === 'mms' || source === 'text') return 'sms';
  if (source === 'email' || source === 'e-mail') return 'email';
  if (source === 'web') return 'web';
  return 'email';
}

async function checkMail(ctx) {
  try {
    await ctx.mailer.check();
    ctx.runtime.mailReady = true;
    ctx.runtime.lastCheck = Date.now();
    console.log('[snitch] mail check ok');
  } catch (err) {
    ctx.runtime.mailReady = false;
    ctx.runtime.lastCheck = Date.now();
    console.error('[snitch] mail check failed:', err.message);
    if (ctx.config.mailMode === 'smtp' && /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|Greeting never|timed out|ECONNRESET/i.test(err.message)) {
      console.error('[snitch] Free Render and Railway plans block SMTP ports 465 and 587. Use Koyeb, a paid Render instance, or MAIL_MODE=apps-script. See README.md.');
    }
  }
}

async function main() {
  const { config, errors } = loadConfig();
  if (errors.length) {
    console.error('Snitch cannot start:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  if (config.mailMode === 'smtp' && config.gmailPass.length !== 16) {
    console.warn(`[snitch] GMAIL_APP_PASSWORD is ${config.gmailPass.length} characters. A Gmail app password is 16 letters.`);
  }

  const ctx = {
    config,
    mailer: createMailer(config),
    runtime: {
      inFlight: 0,
      hits: new Map(),
      sentToday: [],
      mailReady: false,
      lastCheck: 0,
    },
  };

  console.log(`[snitch] mail mode: ${config.mailMode}`);
  console.log(`[snitch] reports go to: ${config.recipients.join(', ')}`);
  if (config.mailMode === 'smtp') {
    console.log(`[snitch] sending as: ${config.fromName} <${config.gmailUser}> via smtp.gmail.com:${config.smtpPort}`);
  }
  console.log(`[snitch] limits: ${config.maxPhotos} photos, ${config.maxTotalMb} MB total, ${config.dailySendMax} reports a day`);
  if (config.accessCode) console.log('[snitch] community code is on');
  if (config.inboundSecret) console.log('[snitch] inbound webhook is on');
  if (config.trustProxy) console.log('[snitch] trusting proxy headers for rate limits');

  const app = createApp(ctx);
  await checkMail(ctx);

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[snitch] open http://localhost:${config.port}`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[snitch] failed to start:', err);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  createApp,
  createMailer,
  sniffImage,
  buildReport,
  sanitizeNote,
  photosFromBuffers,
  canonRecipients,
  parseRecipients,
};
