SOLENT COURSE PWA — FIRST WORKING VERSION

What it does
------------
- Bundles all 157 fixed-position SCRA Solent marks for 2026.
- Accepts rapid course entry such as: 4W 3U(S) 4E 3G
- Supports port/starboard rounding.
- Uses phone GPS for true bearing, distance, speed made good to the selected mark and ETA.
- Supports saved courses, previous/next mark controls, mark search and optional proximity alert.
- Works offline after first load through its service worker.

How to run locally
------------------
A PWA must be served over HTTP/HTTPS rather than opened directly as a file.

On a computer with Python:
1. Unzip this folder.
2. Open Terminal/Command Prompt in the folder.
3. Run:
       python3 -m http.server 8080
4. Open http://localhost:8080

To use it on an iPhone, host this folder on an HTTPS web host (GitHub Pages,
Cloudflare Pages, Netlify, or your own server), open it in Safari, then choose:
Share > Add to Home Screen.

Important
---------
iPhone GPS access requires HTTPS except on localhost.
This is a race aid, not a substitute for official charts, sailing instructions,
notices to mariners or maintaining a proper lookout.

Data source
-----------
SCRA Solent Area Mark Codes 2026, dated 23 February 2026.
