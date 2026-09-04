# Deploying the Worklog PWA

The PWA is a static site (`index.html`, `styles.css`, `app.js`,
`manifest.webmanifest`, `service-worker.js`, `icons/`) — no build step,
no server. Any static host that serves HTTPS works. This guide uses
**GitHub Pages** since this project already lives in a GitHub repo.

> The app **must** be served over HTTPS — service workers (required for
> PWA install/offline support) refuse to register on plain HTTP, except
> on `localhost` during local testing.

## Prerequisite

Finish the Apps Script setup in
[`google-apps-script/README.md`](./google-apps-script/README.md) first
and put the Web App URL into `app.js`'s `CONFIG.APPS_SCRIPT_URL` —
commit that change before deploying.

## Option A: GitHub Pages

1. Push this repository to GitHub (if it isn't already).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a
   branch**.
4. Pick the branch (e.g. `main`) and folder `/ (root)`, then **Save**.
5. Wait a minute for GitHub to build it, then GitHub shows the live
   URL, typically:

   ```
   https://<your-username>.github.io/<repo-name>/
   ```

6. Open that URL — that's your HTTPS deployment.

Every time you push to that branch, GitHub Pages redeploys
automatically.

### Note on subpaths

GitHub Pages project sites are served from a subpath
(`/<repo-name>/`), not the domain root. This project's
`manifest.webmanifest` uses relative paths (`"start_url": "./"`,
`"scope": "./"`), which resolve correctly under a subpath or at a
domain root — no changes needed either way.

## Option B: Cloudflare Pages (root domain, no subpath issues)

1. Go to the [Cloudflare Pages dashboard](https://pages.cloudflare.com/).
2. **Create a project → Connect to Git**, pick this repository.
3. Build settings: leave **Build command** empty and **Build output
   directory** as `/` (this is a static site with no build step).
4. Click **Save and Deploy**.
5. Cloudflare gives you a URL like `https://worklog-app.pages.dev` —
   that's your HTTPS deployment, served from the root, so the default
   `start_url`/`scope` of `/` in the manifest work unmodified.

## Installing on Android (Chrome)

1. Open the deployed HTTPS URL in Chrome on your Android phone.
2. Tap the **three-dot menu** (top right).
3. Tap **Add to Home screen** (or **Install app**, depending on Chrome
   version).
4. Confirm the name (defaults to "Worklog") and tap **Add** / **Install**.
5. An icon appears on your home screen.

## Verifying standalone (installed app) behavior

1. Tap the new home-screen icon.
2. It should open **without** Chrome's address bar / tabs UI — just
   your app's content, like a native app.
3. If it still opens as a normal Chrome tab, check:
   - The site was served over HTTPS.
   - `manifest.webmanifest` loaded successfully (check DevTools →
     Application → Manifest if testing on desktop Chrome first).
   - `"display": "standalone"` is set in the manifest (it is, by
     default, in this project).

## Testing changes before installing

You can preview locally over plain HTTP for layout/UX checks (the
service worker and "Add to Home screen" won't activate over
non-HTTPS, non-localhost origins — that's expected):

```bash
cd worklog-app
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a desktop browser. `localhost` is
treated as a secure context, so the service worker still registers
there for testing.
