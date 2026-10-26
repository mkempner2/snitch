/**
 * Snitch inbound email bridge.
 *
 * Residents email photos to the same Gmail account Snitch sends from.
 * The subject must contain the word Snitch, for example:
 *   Snitch: broken gate by the pool
 * This script posts the message to the Snitch server, which sends the
 * normal HOA report. It skips mail it already handled and anything that
 * already looks like an outbound report, so it does not loop.
 *
 * Photos are forwarded. Tiny images (under 20 KB) are treated as signature
 * icons and dropped when a larger photo is attached.
 *
 * Setup:
 * 1. Deploy Snitch and set INBOUND_SECRET to a long random string.
 * 2. Open https://script.google.com signed in as that Gmail account.
 * 3. New project. Paste this file. Save.
 * 4. Project Settings > Script properties:
 *      WEBHOOK_URL    = https://your-app.example/api/inbound
 *      INBOUND_SECRET = the same value as on the server
 * 5. Select install in the toolbar and Run it once. Approve Gmail and
 *    external-request permissions.
 * 6. Tell neighbors to email that Gmail account with "Snitch" in the subject.
 *
 * The trigger runs every 5 minutes. If the site is asleep, the first try
 * can fail and the message stays unread for the next run.
 */

var PROCESSED_LABEL = 'Snitch/Processed';
var FAILED_LABEL = 'Snitch/Failed';
var MIN_PHOTO_BYTES = 20 * 1024;

function install() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processInbox') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
}

function processInbox() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('INBOUND_SECRET');
  if (!url || !secret) throw new Error('Set WEBHOOK_URL and INBOUND_SECRET script properties.');

  var query = 'is:unread subject:Snitch -subject:"Community Deficiency Report" -from:me -label:"Snitch/Processed"';
  var threads = GmailApp.search(query, 0, 5);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      if (!messages[m].isUnread() || messages[m].isDraft()) continue;
      try {
        handleMessage_(messages[m], url, secret);
      } catch (err) {
        console.error('Snitch inbound error', err);
      }
    }
  }
}

function handleMessage_(message, url, secret) {
  var subject = message.getSubject() || '';
  if (/community deficiency report/i.test(subject)) return;

  var images = imageParts_(message.getAttachments({
    includeInlineImages: false,
    includeAttachments: true,
  }));
  var bytes = 0;
  for (var i = 0; i < images.length; i++) {
    bytes += Math.floor(String(images[i].data || '').length * 3 / 4);
  }
  if (bytes > 15 * 1024 * 1024) {
    console.error('Snitch inbound skipped an email over 15 MB');
    message.markRead();
    label_(FAILED_LABEL).addToThread(message.getThread());
    return;
  }
  var note = extractNote_(message);
  if (!note && !images.length) {
    message.markRead();
    label_(FAILED_LABEL).addToThread(message.getThread());
    return;
  }

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Accept: 'application/json' },
    payload: JSON.stringify({
      secret: secret,
      source: 'email',
      subject: subject,
      from: message.getFrom(),
      note: note,
      images: images,
    }),
  });

  var code = response.getResponseCode();
  if (code >= 200 && code < 300) {
    message.markRead();
    label_(PROCESSED_LABEL).addToThread(message.getThread());
    return;
  }

  console.error('Snitch inbound failed', code, response.getContentText().slice(0, 400));
  // A 4xx will not succeed on retry (bad photo, too large, bad secret).
  // A 5xx or a sleeping host is left unread for the next run.
  if (code >= 400 && code < 500) {
    message.markRead();
    label_(FAILED_LABEL).addToThread(message.getThread());
  }
}

function imageParts_(attachments) {
  var large = [];
  var small = [];
  for (var i = 0; i < attachments.length; i++) {
    var file = attachments[i];
    var name = file.getName() || 'photo';
    var type = file.getContentType() || '';
    var isImage = /^image\//i.test(type) || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(name);
    if (!isImage) continue;
    var bytes = file.getBytes();
    var part = {
      filename: name,
      contentType: type || 'application/octet-stream',
      data: Utilities.base64Encode(bytes),
      size: bytes.length,
    };
    if (bytes.length >= MIN_PHOTO_BYTES) large.push(part);
    else small.push(part);
  }
  var chosen = large.length ? large : small;
  chosen.sort(function (a, b) { return b.size - a.size; });
  return chosen.slice(0, 6).map(function (part) {
    return { filename: part.filename, contentType: part.contentType, data: part.data };
  });
}

function extractNote_(message) {
  var subject = String(message.getSubject() || '').replace(/snitch:?/ig, '').trim();
  var plain = String(message.getPlainBody() || '');
  var lines = plain.split(/\n/);
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed === '--' || /^On .+wrote:$/.test(trimmed)) break;
    kept.push(lines[i]);
  }
  var body = kept.join('\n').trim();
  var note = body && subject ? subject + '\n\n' + body : (body || subject);
  return note.trim().slice(0, 4000);
}

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
