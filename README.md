# Snitch

Snitch is a small website neighbors can open on a phone, attach one or more photos of something the HOA should fix, add an optional note, and send it. The app emails the photos and a short cover letter to an address you configure. There are no accounts.

Photos are held in memory only long enough to attach them to the email. They are not saved on the server.

## What gets emailed

Subject:

```text
Community Deficiency Report – October 25, 2026, 3:04 PM – Light out on Elm
```

The date and time use `REPORT_TIMEZONE`, or UTC if you do not set one. When the resident wrote a note, the subject also includes a short excerpt so each report is distinct. The inbox shows `FROM_NAME` (default `Community Report`) and the Gmail address in `GMAIL_USER`. Set `FROM_NAME` to the community name, for example `East Ridge Community Report`.

Body:

```text
Dear HOA Management,

I am writing to inform you that a fellow resident has noticed a deficiency in our community and requests that it be addressed as quickly as possible, as this is the responsibility of the HOA.

Resident's note:
[the note, or "(no additional note provided)"]

Please see the attached photo(s) documenting the issue.

If you could please respond to this email to acknowledge reception and provide an estimate of when the issue will be resolved, we would greatly appreciate it.

Thank you.
```

A short footer after that records the time, how the report arrived (web form, email, or text message), and the sender when a text or email intake provides one.

The web form requires at least one photo. A deficiency report the HOA can act on needs the picture, and the cover letter refers to the attachments. The note is optional. Text-message intake can send a note without a photo, because most free SMS tools cannot forward pictures. In that case the photo sentence says that no photo was attached.

## Run it locally

The app and the Cloudflare tunnel both run in WSL Alpine. One command starts them.

Install the packages once in Alpine. Node.js 18 or newer is required. Alpine's `nodejs` package is the current LTS.

```sh
apk add nodejs npm curl
```

`cloudflared` is not in the Alpine package repos. If `cloudflared -v` does not print a version:

```sh
curl -fsSL -o /usr/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/bin/cloudflared
```

In this folder:

```sh
npm install
cp .env.example .env
```

Edit `.env` and set the four values in the next section. Also set `TUNNEL_ID` and `TUNNEL_TOKEN`. Then, from an Alpine shell:

```sh
npm run serve
```

That starts Snitch and the named Cloudflare tunnel from `.env`. In the Cloudflare dashboard, set that tunnel's public hostname service to `http://127.0.0.1:8000` (use the port in `PORT` if you changed it). The hostname stays the same across runs. Ctrl-C stops the app and the tunnel together.

The site is also at http://localhost:8000 inside Alpine. After a successful send, the browser goes to a confirmation page.

`npm start` starts the app by itself. Koyeb and Render use that command. See Deploy below.

`npm run serve` sets `TRUST_PROXY=1` when neither the shell nor `.env` already sets it, so rate limits use the visitor address Cloudflare sends.

`npm test` runs the built-in checks (image types, the email text, and the form). Those checks do not send a real email.

The app refuses to start if `HOA_EMAIL` is missing or if the Gmail settings for the mode you chose are incomplete. The message printed in the terminal says which line to fix.

## Gmail app password

Snitch sends through a free Gmail account over SMTP. Google will not accept the account's normal password. Use an app password. A separate Gmail account for this (something like `elmcourt.snitch@gmail.com`) keeps HOA reports out of a personal inbox. Replies from the HOA come back to that same inbox, so put a name or unit in the note if someone wants a follow-up. The form does not ask for contact details.

1. Sign in as the sending account.
2. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/two-step-verification
3. Create an app password: https://myaccount.google.com/apppasswords
   - Name it `Snitch`.
   - Copy the 16-character password. Spaces do not matter; Snitch removes them.
4. Put the Gmail address in `GMAIL_USER` and the app password in `GMAIL_APP_PASSWORD`.

The app-password page stays hidden until 2-Step Verification is on. It is also unavailable for accounts enrolled in Google's Advanced Protection Program. On a Google Workspace account, an admin has to allow app passwords.

When you start the app it checks the SMTP login. `mail check ok` in the log means Gmail accepted it. `Invalid login` means the app password or the address is wrong.

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`. It is listed in `.gitignore`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GMAIL_USER` | SMTP mode | Gmail address that sends the reports |
| `GMAIL_APP_PASSWORD` | SMTP mode | 16-character app password, not the normal password |
| `HOA_EMAIL` | Always | Who receives reports. Separate extra addresses with commas (up to 10). |
| `PORT` | No | Defaults to 8000. Render and Koyeb set this themselves. |
| `REPORT_TIMEZONE` | No | IANA name, such as `America/Chicago`. Defaults to `UTC`. |
| `SMTP_PORT` | No | `587` (default, STARTTLS) or `465` |
| `TRUST_PROXY` | On a host | Set to `1` so rate limits use the visitor's address. Render sets this on its own. |
| `TUNNEL_ID` | `npm run serve` | UUID of the Cloudflare tunnel. |
| `TUNNEL_TOKEN` | `npm run serve` | Long token from that tunnel's install command. Secret. The token's tunnel id must match `TUNNEL_ID`. |
| `ACCESS_CODE` | No | If set, the form asks for this code before it will send. |
| `INBOUND_SECRET` | No | Turns on `POST /api/inbound`. Use a long random string. |
| `MAX_PHOTOS` | No | Default 6 |
| `MAX_TOTAL_MB` | No | Default 15, maximum 18 |
| `NOTE_MAX_LENGTH` | No | Default 4000 characters |
| `RATE_LIMIT_MAX` | No | Default 20 reports per address per window |
| `RATE_LIMIT_WINDOW_MIN` | No | Default 60 minutes |
| `DAILY_SEND_MAX` | No | Default 100 successful sends per process |
| `MAIL_MODE` | No | `smtp` (default) or `apps-script` |
| `APPS_SCRIPT_URL` | Apps Script mode | Web app URL ending in `/exec` |
| `APPS_SCRIPT_SECRET` | Apps Script mode | Same value as `RELAY_SECRET` in the script |

Anyone who can open the site can email your HOA and use up the Gmail daily quota. Set `ACCESS_CODE` and share it once in the neighborhood newsletter or group chat. Inbound email and SMS use `INBOUND_SECRET` instead of the community code.

## Use the web form

1. Open the site on a phone or computer.
2. Enter the community code if the page asks for one.
3. Add a note if you want. The name, unit, or a good location helps the HOA.
4. Add one or more photos. You can take them or choose them from the camera roll. On a computer you can drag photos onto the box.
5. Press **Send to the HOA**. The button changes to **Sending report…** until the message is gone.
6. The confirmation page says the HOA has the report.

Leave the page open while it sends. On a free host that has gone to sleep, the first request can take about a minute.

The form works without JavaScript: the browser posts the form, and a successful send redirects to the confirmation page. With JavaScript, errors stay on the form so the photos are not lost.

## Limits

Accepted types: JPG, JPEG, PNG, GIF, WEBP, and HEIC/HEIF. The server checks the file bytes, not just the file name, so a PDF renamed to `.jpg` is rejected. Other files (video, PDF, Word) are not accepted.

Defaults:

- At least one photo on the web form, up to 6.
- 15 MB total per report. One photo can use the whole budget.
- Note up to 4000 characters. An empty note is sent as `(no additional note provided)`.
- 20 submissions an hour per network address. Neighbors on the same Wi-Fi share that allowance. Raise `RATE_LIMIT_MAX` if a meeting would trip it.
- 100 successful sends a day inside this process, so a public link cannot quietly burn the whole Gmail quota. The counter lives in memory and starts over when the app restarts or a free host sleeps. Gmail's own limit still applies.
- Three uploads are read at a time. A fourth waits with a "try again" message, which keeps a small free instance from holding dozens of photo uploads in RAM.

iPhones often shoot HEIC. Snitch accepts it. Some browsers convert HEIC to JPEG before upload; either file is fine. A HEIC photo may show as a name tile instead of a thumbnail. It still sends.

There is a hidden field humans do not see. Automated clients that fill every field are dropped and shown the success page so they do not retry. Nothing is emailed.

### Gmail sending limits

A free Gmail account can send to about **500 recipients per rolling 24 hours**. A Google Workspace account is about **2,000 per day**. Each address in `HOA_EMAIL` counts as a recipient, so one report to three board addresses counts as three. A single HOA address counts as one. Google pauses sending for up to 24 hours after the limit, and Snitch shows that as a daily-limit message.

Gmail also rejects a message larger than 25 MB. Photo bytes grow by about a third when they are encoded for email, which is why the upload cap is 15 MB rather than 25.

App passwords and this volume of mail are free. This is a poor fit for newsletters or anything sent to a large list.

## If reports land in spam

Gmail accepted the message. The spam folder is a later decision by the receiving mailbox. A brand-new Gmail address that sends the same kind of report over and over, especially while its first messages had tiny test photos, is easy for that filter to file away. Snitch already sends through Google's own SMTP servers, so this is not a missing SPF or DKIM setting you can turn on for an `@gmail.com` address.

Do this once in the mailbox that receives the reports (`HOA_EMAIL`):

1. Open one of the Snitch messages in Spam.
2. Click **Report not spam** (Gmail also shows this as **Not spam**).
3. Add `GMAIL_USER` to Google Contacts. In the message, click the sender, then **Add to Contacts**.
4. Create a filter so later reports skip spam. In Gmail search, enter `from:your-sending-address@gmail.com`, open the filter menu, and choose **Create filter**. Check **Never send it to Spam**, then create the filter.
5. Reply once to that message, even with a short "received." A reply is the strongest signal Gmail keeps for that pair of addresses.

After those steps, the next report should arrive in the inbox. Reports sent before the filter was created stay in Spam until you mark them.

If the HOA later uses Microsoft 365 or Google Workspace, an admin can also allowlist the sending address in the mail gateway. That is the same idea: tell the receiving system this sender is expected. A custom domain with its own SPF, DKIM, and DMARC record is worth it only if the HOA outgrows the free Gmail account. It does not replace the steps above for the mailbox you are using now.

## Deploy

Push this folder to a private GitHub repository first. Do not commit `.env`.

Snitch sends mail on **port 587** by default. That only works on a host that allows outbound SMTP. Two popular free plans do not:

- [Render's free web services](https://render.com/docs/free) block outbound ports 25, 465, and 587. Port 25 is blocked on every Render plan. Ports 465 and 587 work on a **paid** Render instance (the smallest web service is about $7 a month).
- [Railway](https://docs.railway.com/reference/outbound-networking) disables SMTP on Free, Trial, and Hobby. SMTP starts on the Pro plan.

The simplest free host that can run the default Gmail SMTP setup is **Koyeb**. Its free instance allows port 587 (it blocks port 25 only). Render's free tier can still host the site if you turn on the Apps Script relay below, which sends the same Gmail message over HTTPS.

Set `TRUST_PROXY=1` on any of these hosts. Without it, every visitor looks like the same proxy and they share one rate limit.

### Koyeb (free, Gmail SMTP works)

The free instance is one per organization: 512 MB RAM, 0.1 vCPU, in Frankfurt or Washington, D.C. It scales to zero after **1 hour** without traffic. The next visit wakes it. Koyeb's paid instances can sleep faster; the free one uses that 1 hour window. Details: [Koyeb instances](https://www.koyeb.com/docs/reference/instances) and [ports](https://www.koyeb.com/docs/faqs/general).

1. Create a Koyeb account and click **Create Web Service**. Choose **GitHub** and install the Koyeb GitHub app if asked.
2. Select this repository. Builder: **Buildpack**. Run command: `npm start` (a `Procfile` is also included).
3. Instance type: **Free**. Pick Washington or Frankfurt.
4. Add environment variables: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `HOA_EMAIL`, `TRUST_PROXY=1`, and `REPORT_TIMEZONE` if you want one. Do not set `PORT`; Koyeb provides it.
5. Set the health check path to `/health`.
6. Deploy. Open the `*.koyeb.app` URL. The log line `mail check ok` means Gmail is reachable.

`/health` returns `{ "ok": true, "mail": true }` when SMTP (or the relay) last checked out. `mail: false` means the site is up but reports will fail until the log's mail error is fixed.

### Render

Render is the other documented path. Read the port limit above before choosing the free instance.

1. Create a Render account, then **New +** > **Web Service**, and connect the GitHub repo.
2. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
3. Instance type: **Free** only if you will use the Apps Script relay. Otherwise pick a paid instance so SMTP on port 587 works.
4. Add the environment variables from the table. `TRUST_PROXY` turns on by itself when Render sets `RENDER=true`. Add `PORT` only if you want to override Render's port; normally leave it unset and let Render set it.
5. Health check path: `/health`.
6. Deploy and read the logs.

Free-instance behavior, from Render's docs:

- The service **spins down after 15 minutes** without a request. The next visit takes about a minute while it starts. Render shows its own loading page during that wait. Spun-down time does not use the free-hour budget.
- Each workspace gets **750 free instance hours a month**. One service left running all month uses about that entire budget (a month is roughly 744 hours). Hours reset at the start of the month and do not roll over. If you run out, Render suspends free web services until next month.
- The disk is ephemeral. Snitch does not need a disk.
- Render may restart a free service at any time.
- While the service is spun down, Render answers `/robots.txt` itself with "disallow all". Snitch also ships a `robots.txt` that asks crawlers to stay out while the app is awake.

### Keep a free instance awake

A monitor can request `/health` so the first neighbor does not wait for a cold start.

- [UptimeRobot](https://uptimerobot.com/) or [cron-job.org](https://cron-job.org/) both have free plans.
- URL: `https://your-app.example/health`
- Interval: every 10 minutes for Render (it sleeps at 15). Every 30–45 minutes is enough for Koyeb's free instance (it sleeps at 1 hour).

On Render, keeping one service awake all month spends the 750-hour allowance, which is what that allowance is sized for. Letting it sleep is free of that cost and makes the first open of the evening slow. Pick whichever is less annoying. Do not point the monitor at a path that sends email.

### Apps Script relay (Render free, or any host that blocks SMTP)

`scripts/apps-script-relay.gs` sends the report with the Gmail account that owns the script. The Node app still writes the subject and body. The script refuses any message that is not a Snitch report, and it only delivers to the `HOA_EMAIL` saved in the script, so the URL is not an open mail relay.

1. Open https://script.google.com as the sending Gmail account. Create a project and paste `scripts/apps-script-relay.gs`.
2. Project Settings > Script properties:
   - `RELAY_SECRET` — a long random string
   - `HOA_EMAIL` — the same recipient list as on the server
3. **Deploy > New deployment > Web app**. Execute as **Me**. Who has access: **Anyone**.
4. Copy the URL that ends in `/exec`.
5. On the host, set:
   - `MAIL_MODE=apps-script`
   - `APPS_SCRIPT_URL` to that `/exec` URL
   - `APPS_SCRIPT_SECRET` to the same string as `RELAY_SECRET`
6. Redeploy the Node app. The log should show `mail mode: apps-script` and `mail check ok`.

You do not need `GMAIL_APP_PASSWORD` in this mode. After you edit the script, use **Manage deployments > Edit > New version** so the URL does not change.

A consumer Google account can send about 100 messages a day through Apps Script, which is lower than the SMTP quota and still plenty for an HOA. The relay is a fallback for blocked SMTP, not a second copy of the product. Prefer Koyeb or a paid Render instance and leave `MAIL_MODE` on `smtp` when you can.

## Email intake

Full inbound email is optional. Residents can keep using the web form and you can skip this.

When `INBOUND_SECRET` is set, Snitch accepts:

`POST /api/inbound`

- Header `Authorization: Bearer <INBOUND_SECRET>`, or header `X-Inbound-Secret`, or `?secret=` on the URL. Prefer the header. A secret in the URL can end up in logs.
- JSON: `{ "note", "source": "email", "from", "subject", "images": [{ "filename", "contentType", "data": "<base64>" }] }`
- Or the same multipart fields as the web form (`note`, `photos`).

A message whose subject already starts with "Community Deficiency Report" is rejected so an outbound report cannot be fed back in.

`scripts/gmail-inbound.gs` is a free bridge that uses the Gmail account you already have. No extra email service.

1. Set `INBOUND_SECRET` on the server.
2. Paste the script into https://script.google.com as that Gmail user.
3. Script properties: `WEBHOOK_URL` = `https://your-app.example/api/inbound`, and `INBOUND_SECRET` matching the server.
4. Run `install` once and approve the Gmail and external-URL prompts. It checks for mail every 5 minutes.
5. Tell neighbors to email that Gmail address with **Snitch** in the subject, photos attached, and the description in the body. Example subject: `Snitch: broken gate by the pool`.

The script marks a handled message read and labels the thread `Snitch/Processed`. A message the server refuses (too large, not a photo) is labeled `Snitch/Failed` and left for you. If the site is asleep, the call fails and the message stays unread for the next run.

This calls the Node app, which then sends the HOA email. On Render free, that only works if the Apps Script **relay** is also on. The inbound script and the relay are two different scripts.

## Text and photo messages (SMS / MMS)

`POST /api/inbound/sms` is the same webhook with the source forced to "text message". It is off until `INBOUND_SECRET` is set. A note is enough. Photos are accepted if the phone app can actually send them; most free apps cannot.

[SmsForwarder](https://github.com/pppscn/SmsForwarder) is free and open source. On a spare or everyday Android phone:

1. Install it and allow it to read SMS.
2. Add a Webhook sender. URL:

   ```text
   https://your-app.example/api/inbound/sms?secret=YOUR_LONG_SECRET
   ```

3. Set the webhook body to JSON:

   ```json
   {"from":"[from]","content":"[content]","source":"sms"}
   ```

   SmsForwarder replaces `[from]` and `[content]`. See its webhook notes if you would rather send form fields (`from` and `content`), which Snitch also accepts.

4. Add a rule that forwards SMS to that webhook.

The text and the sending number are included in the email footer. Picture messages usually do not come through this kind of app. For photos, use the web form or the email intake.

There is no free, reliable MMS gateway worth adding here. A paid SMS API would break the "near zero cost" goal, so Snitch does not depend on one.

## Project layout

```text
server.js                  Express app, checks, and mail
public/index.html          The form
public/success.html        Confirmation page
public/styles.css
public/app.js
public/favicon.svg
scripts/serve.sh               App and Cloudflare tunnel, one Alpine command
scripts/apps-script-relay.gs   Optional HTTPS send path
scripts/gmail-inbound.gs       Optional "email Snitch a photo" bridge
.env.example
Procfile                   Start command for buildpack hosts
test/report.test.js
```

## Troubleshooting

| What you see | What to do |
| --- | --- |
| App exits at startup listing variables | Fill in `.env` or the host's environment screen. |
| `Invalid login` / `535` | Use an app password, not the normal Gmail password. 2-Step Verification has to be on. |
| `ETIMEDOUT` or "Could not reach Gmail" | The host is blocking SMTP. Use Koyeb, a paid Render instance, or `MAIL_MODE=apps-script`. |
| Daily limit | Wait up to 24 hours, or send fewer reports. Each extra address on `HOA_EMAIL` counts. |
| Photo rejected | Send JPG, PNG, GIF, WEBP, or HEIC. The file's contents have to match. |
| `mail: false` on `/health` | Read the host logs for the mail-check line. The page still loads. |
| First visit is very slow | The free instance was asleep. See "Keep a free instance awake". |
| Tunnel address does not load the form | Run `npm run serve` in Alpine. That command starts the app and the tunnel together, both using Alpine's localhost. The tunnel's public hostname service must be `http://127.0.0.1:8000`. |
| `TUNNEL_TOKEN is not a Cloudflare tunnel token` | Paste the long install token into `TUNNEL_TOKEN`. `TUNNEL_ID` is only the UUID. |
| Everyone gets "too many reports" | Set `TRUST_PROXY=1`. Otherwise the host looks like one visitor. |
