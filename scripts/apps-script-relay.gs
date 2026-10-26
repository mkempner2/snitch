/**
 * Snitch mail relay.
 *
 * Use this only when the host blocks outbound SMTP (Render's free instance,
 * Railway Free and Hobby). The Node app composes the report and POSTs it
 * here. This script sends that exact message through the Gmail account that
 * owns the script. It will not send any other kind of mail.
 *
 * Setup:
 * 1. Open https://script.google.com signed in as the Gmail account that
 *    should send reports. A free Gmail account is enough.
 * 2. New project. Paste this file. Save.
 * 3. Project Settings (gear) > Script properties:
 *      RELAY_SECRET = a long random string (same as APPS_SCRIPT_SECRET)
 *      HOA_EMAIL    = the same address or comma-separated list as HOA_EMAIL
 * 4. Deploy > New deployment > gear > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 * 5. Copy the web app URL ending in /exec into APPS_SCRIPT_URL.
 * 6. On the server set MAIL_MODE=apps-script, APPS_SCRIPT_URL, and
 *    APPS_SCRIPT_SECRET. GMAIL_APP_PASSWORD is not used in this mode.
 *
 * After you edit this file, deploy again with Manage deployments > Edit >
 * New version, so the URL stays the same.
 */

var MAX_RELAY_PHOTOS = 8;
var MAX_RELAY_BYTES = 18 * 1024 * 1024;

function doGet() {
  return json_({ ok: true, service: 'snitch-relay' });
}

function doPost(e) {
  try {
    var data = JSON.parse((e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('RELAY_SECRET') || '';
    var allowed = props.getProperty('HOA_EMAIL') || '';

    if (!secret || String(data.secret || '') !== secret) {
      return json_({ ok: false, error: 'Unauthorized' });
    }

    if (data.ping === true) {
      return json_({ ok: true, quota: MailApp.getRemainingDailyQuota() });
    }

    if (canon_(data.to) !== canon_(allowed)) {
      return json_({ ok: false, error: 'Recipient does not match HOA_EMAIL on the relay.' });
    }
    if (!/^Community Deficiency Report/.test(String(data.subject || ''))) {
      return json_({ ok: false, error: 'Unexpected subject.' });
    }
    if (String(data.text || '').indexOf('Dear HOA Management,') !== 0) {
      return json_({ ok: false, error: 'Unexpected message.' });
    }

    var images = data.images || [];
    if (images.length > MAX_RELAY_PHOTOS) {
      return json_({ ok: false, error: 'Too many photos.' });
    }

    var blobs = [];
    var total = 0;
    for (var i = 0; i < images.length; i++) {
      var bytes = Utilities.base64Decode(String(images[i].data || ''));
      total += bytes.length;
      if (total > MAX_RELAY_BYTES) return json_({ ok: false, error: 'Photos are too large.' });
      blobs.push(Utilities.newBlob(
        bytes,
        images[i].contentType || 'application/octet-stream',
        safeName_(images[i].filename, i)
      ));
    }

    var fromName = String(data.fromName || 'Community Report')
      .replace(/[\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 70);
    var options = { name: fromName || 'Community Report' };
    if (blobs.length) options.attachments = blobs;
    GmailApp.sendEmail(allowed, String(data.subject), String(data.text), options);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function canon_(value) {
  return String(value || '')
    .split(/[;,]/)
    .map(function (part) { return part.trim().toLowerCase(); })
    .filter(function (part) { return part; })
    .sort()
    .join(',');
}

function safeName_(name, index) {
  var clean = String(name || ('photo-' + (index + 1))).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  return clean || ('photo-' + (index + 1));
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
