# YouTube Scheduler

YouTube Scheduler is a bilingual Windows desktop application for reviewing and
creating recurring YouTube Live broadcasts. The current Python command-line
tool remains available as a legacy reference while the desktop application is
validated.

## Desktop application

The desktop app uses Electron, Svelte 5, and TypeScript. It supports:

- Windows 10/11 on x64 and ARM64;
- English and French, system light/dark appearance, and system timezone
  defaults;
- daily, weekly, and selected-weekday schedules with multiple times;
- title and multiline description templates using `{session}`, `{date}`, and
  `{time}`;
- review and per-broadcast exclusion before anything is created;
- optional thumbnails and playlists;
- private, unlisted, public, and private-until-start visibility;
- a stable reusable stream key per channel, or separate keys per broadcast;
- progress, safe stopping, transient retries, and resumable partial batches;
- local history for the latest 30 batches; and
- manual update notifications through GitHub Releases.

Imported OAuth client configuration and user tokens are encrypted with
Electron's Windows secure storage integration. OAuth data and stream keys are
excluded from history and diagnostic logs.

### Google OAuth configuration

This is intended for personal use or a small trusted group. Each user supplies
a Google Desktop OAuth JSON locally; no OAuth client is embedded in an
installer:

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure an External OAuth consent screen with the
   `https://www.googleapis.com/auth/youtube.force-ssl` scope.
4. Switch the app from Testing to **In production**. Otherwise refresh tokens
   using YouTube scopes expire after seven days.
5. Create a **Desktop app** OAuth client.

The app may remain unverified for fewer than 100 trusted users. Google will
show those users an unverified-app warning during their first login.

Download the Desktop app client as JSON. On first launch, choose that file in
YouTube Scheduler, then connect the YouTube account in the browser. The app
validates the JSON and stores its client configuration in encrypted Windows
user storage. It accepts both current public desktop clients and older desktop
clients whose JSON includes a client secret. It never uploads the file, writes
it into the repository, or adds it to the installer. Choosing another JSON
later is available from the login screen and Settings and signs out the current
account.

### Develop and test

Node.js 24 and npm are recommended:

```bash
npm install
npm run dev
```

Run all TypeScript and legacy Python checks:

```bash
npm run typecheck
npm test
uv run python -m unittest discover -s tests -p 'test_*.py'
```

The Linux development host needs Electron's normal desktop runtime libraries
to open the window. Compilation and unit tests do not require a graphical
session.

For safe visual review without a YouTube account, start the development-only
fixture server with `npm run ui:fixtures`, then open a URL such as
`http://localhost:5173/?fixture=review&locale=fr&theme=dark`. Available fixture
names include `auth`, `schedule`, `review`, `large`, `progress`, `success`,
`history`, `settings`, `description`, `close`, `error`, and `update`. Fixtures
are disabled in production builds.

### Build Windows installers

Build on Windows, or let the release workflow build on a Windows runner:

```bash
npm run dist:win:x64
npm run dist:win:arm64
```

Artifacts are written to `release/` with architecture-specific names. The NSIS
installer is per-user, requires no administrator access, and preserves local
app data during uninstall.

Version 1 installers are intentionally unsigned. Windows SmartScreen may ask a
trusted user to approve the app manually. Tagged releases (`v*`) build both
architectures, calculate SHA-256 checksums, and publish them through GitHub
Releases. Release builds contain no Google OAuth credentials.

### Release acceptance

Before calling a release supported, test both the x64 and ARM64 installers on
real Windows machines:

1. Install and launch as a normal non-administrator user.
2. Choose a downloaded Google Desktop OAuth JSON, authenticate, and verify the
   displayed YouTube channel.
3. Create one Private broadcast with no thumbnail or playlist.
4. Confirm its date, timezone, title, stream binding, and Studio link.
5. Close and reopen the app, confirm history, and reveal the stream key.
6. Exercise stop/resume with a small disposable Private batch.
7. Remove the test broadcasts manually in YouTube Studio.

## Legacy Python CLI

## Connect a YouTube account

The OAuth client and login token are intentionally not stored in GitHub.

On a new computer:

1. Clone the repository and install
   [uv](https://docs.astral.sh/uv/getting-started/installation/) if needed.
2. In Google Cloud, create a **Desktop app** OAuth client for a project with
   **YouTube Data API v3** enabled.
3. Download its JSON file, rename it to `client_secrets.json`, and place it in
   the repository root.
4. Run:

   ```bash
   uv run authenticate.py
   ```

5. Sign in through the browser and select the intended YouTube channel. The
   script prints the connected channel and saves `token.pickle` locally.

To switch accounts later, remove `token.pickle` and rerun the script:

```bash
rm token.pickle
uv run authenticate.py
```

Never commit `client_secrets.json` or `token.pickle`; both are already listed
in `.gitignore`.

## Schedule streams

`--n` is the number of cadence periods to create. Use `--start_time` once for
the first time and `--start_time+` for each additional time. Each selected day
gets a stream at every provided time. The default cadence is `weekly`,
preserving the original behavior.

Schedule one stream per week for three weeks:

```bash
uv run schedule.py \
  --n 3 \
  --start_date 26-07-2026 \
  --start_time 20:00 \
  --title "Weekly session %d.%m.%y" \
  --cadence weekly \
  --privacy unlisted
```

Schedule two streams per day for five days (ten streams total):

```bash
uv run schedule.py \
  --n 5 \
  --start_date 26-07-2026 \
  --start_time 08:00 \
  --start_time+ 20:00 \
  --title "Session {session:02d} - %d.%m.%y at %H:%M" \
  --cadence daily \
  --thumbnail assets/session-thumbnail.png \
  --privacy unlisted
```

Times are interpreted in `Asia/Jerusalem` unless `--tz` is provided. If the
earliest time on the starting date is already past, the whole group advances
to the next day or week so all sessions stay together.

Titles continue to support `strftime` date/time tokens. They also support
`{session}` for the session number, or a format such as `{session:02d}` for
zero-padded numbers. Sessions are numbered chronologically from 1 and restart
at 1 each time the command runs.

Use `--thumbnail` to apply the same custom thumbnail to every scheduled video.
The image must be a PNG or JPEG no larger than 2 MB; 1280x720 with a 16:9
aspect ratio is recommended. The thumbnail is uploaded once for each video,
so each upload consumes additional YouTube API quota.

By default, the script creates one reusable stream key and binds every
scheduled video to it:

```bash
uv run schedule.py \
  --n 5 \
  --start_date 26-07-2026 \
  --start_time 20:00 \
  --title "Session {session} - %d.%m.%y" \
  --cadence daily \
  --privacy unlisted
```

This is useful when the same encoder handles recurring broadcasts. Use
`--shared_stream_key false` when broadcasts need different stream keys or
carry independent content at the same time.
