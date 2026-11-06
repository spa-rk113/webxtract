# WebXtract Universal Web Inspector 4.3.1

WebXtract 4.3.1 is a local-first website crawler and resource inspector. It has two complementary scan modes:

1. **Deep crawl** — recursively visits same-host pages, discovers linked assets, and parses linked CSS and JavaScript for secondary references.
2. **Browser scan** — optional Playwright/Chromium mode. It executes page JavaScript, watches network responses, waits for runtime requests, scrolls to trigger lazy loading, and visits discovered same-host links.

It can discover and download publicly accessible resources that you are authorized to inspect. It does not promise a perfect copy of every site. Resources gated behind login, user interaction, POST-only APIs, DRM, paywalls, anti-bot checks, or other access controls may not be available. Browser mode is read-only and proxies GET requests through the local server; it does not submit forms or perform purchases.

## Requirements

- Node.js 18 or newer.
- No required npm packages for Deep crawl.
- Optional Playwright + Chromium for Browser scan on supported desktop Linux/Windows environments.

## Android / Termux (recommended workflow)

Deep crawl is the recommended mode on Android. Browser automation packages and Chromium are not reliably supported by every Android/Termux device.

```bash
pkg update
pkg install nodejs unzip
termux-setup-storage
cd ~/storage/downloads
unzip WebXtract-Universal-Web-Inspector-4.3.1.zip
cd WebXtract-V4.3.1
node server.js
```

Open this address in your Android browser:

```text
http://127.0.0.1:3001/
```

Keep the Termux session running while using the page. Stop the server with `Ctrl+C`.

If port 3001 is busy:

```bash
PORT=3002 node server.js
```

Then open `http://127.0.0.1:3002/`.

### Acode on Android

1. Extract the ZIP using your file manager or Termux.
2. Open the extracted `WebXtract-V4.3.1` folder in Acode to view/edit the files.
3. Start the server from Termux using the commands above. Acode is the editor; Termux runs Node.js.
4. Open the localhost address in Chrome or another browser.

## Linux

Install Node.js 18+ and unzip the project. From the project folder:

```bash
node server.js
```

Open `http://127.0.0.1:3001/`.

### Enable Browser scan on Linux

Install the optional browser automation package and Chromium:

```bash
npm run setup-browser
```

If Chromium is installed separately, you can point WebXtract to it:

```bash
CHROME_PATH=/path/to/chromium node server.js
```

Then choose **Browser scan (dynamic resources)** in the UI. Browser scan can be slower and uses more RAM than Deep crawl.

## Windows CMD

1. Install Node.js 18+ from the official Node.js website.
2. Extract the ZIP.
3. Open Command Prompt in the `WebXtract-V4.3.1` folder.
4. Run:

```cmd
node server.js
```

5. Open `http://127.0.0.1:3001/`.

For optional Browser scan, run:

```cmd
npm run setup-browser
```

If using a separately installed Chrome/Chromium, set its executable path before starting the server:

```cmd
set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
node server.js
```

## How to use

1. Enter the public website's full URL, including `https://`.
2. Choose **Deep crawl** or **Browser scan**.
3. Set crawl depth (1–5) and page cap (10, 20, 40, 60, or 100).
4. Press **Scan website**.
5. Filter the results, select the resources you want, and choose **Download selected ZIP**.
6. The ZIP includes the downloaded files and `manifest.json` with source URLs, categories, and sizes. ZIP progress reports fetching/validation, archive assembly, finalization, and transfer to the browser.

### Scan modes

**Deep crawl**
- Starts at the URL you enter.
- Follows same-host page links up to the selected depth and page limit.
- Discovers assets referenced by HTML attributes and `srcset`.
- Fetches a bounded set of linked CSS and JavaScript files and parses references such as CSS `url(...)`, `@import`, JS imports, and common asset/worker/WASM string references.
- Includes publicly reachable external CDN assets referenced by the pages.

**Browser scan**
- Requires the optional Playwright/Chromium setup.
- Runs page JavaScript and observes responses requested during load and a short runtime wait.
- Scrolls the page to encourage lazy-loaded resources to appear.
- Visits discovered same-host links within the selected page cap.
- Uses read-only GET requests through WebXtract's validated local fetch layer. POST/PUT and other non-GET requests are blocked, so some applications will not fully initialize.
- Some resources are loaded only after clicks, login, user gestures, time delays, or application-specific state. Those may not be captured.

## Limits and safety

- Default bind address: `127.0.0.1` (local device only).
- Deep crawl: at most 40 pages, depth 3, and 300 discovered resources.
- Browser scan: at most 20 pages and 300 observed resources.
- Maximum HTML/page inspection body: 3 MB.
- Maximum individual downloaded file: 12 MB.
- Maximum ZIP payload: 100 MB. Resource downloads run up to four at a time; page crawling and CSS/JavaScript parsing also use bounded concurrency. ZIP files are stored without compression to avoid spending extra CPU on already-compressed images, audio and video.
- Maximum redirects per remote fetch: 5.
- Only standard HTTP/HTTPS ports are accepted.
- HTTPS is the default. HTTP requires checking the explicit opt-in box.
- Private, loopback, link-local, reserved, and non-public IPv4 destinations are blocked. DNS is resolved and pinned for server-side fetches; redirects are revalidated.
- Browser scan routes remote GET traffic through that same validated fetch layer instead of letting Chromium resolve remote hosts independently.
- No cookies, browser login session, or credentials are forwarded to the target website.
- The tool does not execute downloaded JavaScript as a local application, defeat DRM, bypass authentication, or access private resources.

The server should remain bound to localhost. Do not expose it to the public internet or set `HOST=0.0.0.0` unless you understand the security implications and have separately secured the environment.

## Troubleshooting

- **`node: command not found`**: install Node.js (Termux: `pkg install nodejs`).
- **Port already in use**: use `PORT=3002 node server.js` (Windows CMD: `set PORT=3002` then `node server.js`).
- **Browser scan says Playwright is missing**: run `npm run setup-browser` on a supported desktop system. On Android/Termux, use Deep crawl if Chromium cannot be installed.
- **Some files are missing**: increase depth/page cap, try Browser scan on desktop, and remember that login-only, interaction-only, POST-only, or protected resources cannot necessarily be discovered.
- **A resource is blocked**: the destination may be HTTP without opt-in, private/reserved, unsupported, or unreachable.
- **ZIP exceeds limits**: download fewer files at a time or choose smaller resources.

## Project files

- `server.js` — local HTTP server, safe remote fetching, concurrent crawler, optional browser scan, fast ZIP builder.
- `index.html` — user interface.
- `styles.css` — interface styling.
- `app.js` — browser-side UI behavior.
- `package.json` — Node metadata and optional browser setup script.
- `LICENSE` — MIT license.

## License

MIT. See `LICENSE`.


## Live progress (4.3.1)

The interface now shows a compact progress bar and current phase for:
- website validation and page fetching;
- CSS/JavaScript inspection;
- discovered-resource checks;
- selected-file downloads;
- ZIP assembly and completion.

Progress is polled from the local server and reports completed work where the server can measure it. ZIP assembly is shown as a separate phase; the browser download itself begins after the archive has been built. Progress polling is excluded from the normal request rate limit.


## Expanded V4.3.1 limits and progress

- Up to 100 pages per deep crawl, depth up to 5.
- Up to 600 discovered resources.
- Up to 5 MB HTML per scanned page.
- Up to 20 MB per downloaded file.
- Up to 150 MB total downloaded files per ZIP.
- Up to 120 linked CSS/JavaScript files considered for secondary reference parsing.
- Bounded concurrency: 4 pages, 6 CSS/JS files, 8 resource checks, and 4 ZIP downloads at a time.

The progress panel reports page fetching, CSS/JavaScript inspection, destination checks, selected-file fetching/validation, ZIP assembly, finalization, and browser transfer. ZIP assembly yields between chunks/entries so the progress endpoint remains responsive.

**Android memory note:** ZIP files are buffered before delivery. Large selections can temporarily require substantially more RAM than the archive size. On phones, start with smaller selections and increase gradually. The 150 MB cap is a ceiling, not a recommended routine selection size. Browser scan is capped at 40 pages.


## V4.3.1 interface updates

- Set custom scan depth (0–5), page limit (1–100), and discovered-resource limit (1–600) directly in the scan controls.
- The server enforces the same hard ceilings even if a client submits larger values.
- The category filter always lists the supported resource categories, even when a scan found none in a category.
- Select all files and Deselect all files act on the complete discovered-resource list, not only the currently filtered category.
- A compact ZIP progress bar sits beside the download button and reports server-side fetching/validation, ZIP assembly, and browser transfer progress.

The 600-resource, 100-page, depth-5, 20 MB-per-file and 150 MB-total limits are hard safety ceilings, not targets. Large selections can require substantial RAM on Android. Start with smaller limits and increase gradually.
