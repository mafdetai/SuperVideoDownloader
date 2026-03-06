# Usage Guide (Illustrated)

For educational use only. Use it only for content you own, published, or have explicit permission to download. Platform accounts are not provided; please prepare and log in with your own.

## Supported Sites
- Video button: X/Twitter post pages, Xiaohongshu `/explore/`, and generic pages with direct MP4 `<video>` tags. Instagram video is not supported.
- Image buttons: X/Twitter posts, Instagram post pages, Xiaohongshu `explore` posts. Feeds/profiles use batch mode.

## 1. Open Extensions Page
Open the extensions page in Chrome or Edge:
- Chrome: `chrome://extensions/`
- Edge: `edge://extensions/`

![Open extensions page](images/step1_extensions.svg)

## 2. Enable Developer Mode
Turn on **Developer mode** in the top-right corner.

![Enable developer mode](images/step2_developer_mode.svg)

## 3. Load Unpacked Extension
Click **Load unpacked** and choose the project root (the folder containing `manifest.json`).

![Load unpacked](images/step3_load_unpacked.svg)

## 4. Open Target Page and Launch Extension
Open the target post/page and click the extension icon.
Supported platforms: X/Twitter, Xiaohongshu, Instagram (images only), and generic pages with direct MP4 videos.

![Open target page and launch extension](images/step4_open_and_popup.svg)

## 5. Choose a Button to Download
- Download current page video
- Download post images (all)
- Download post images (precise)

![Choose a button](images/step5_buttons.svg)

## Default Config (Optional)
If you changed configs and things break, copy these defaults back into the top constants section of each file.

`popup.js` top constants:
```js
const BATCH_SIZE = 20;
const BATCH_STATE_TTL_MS = 0;
const INS_MIN_VIDEO_BYTES = 150 * 1024;
```

`background.js` top constants:
```js
const IMAGE_MIN_BYTES = 10 * 1024;
const MAX_IMAGE_DOWNLOADS = 20;
const CONVERT_WEBP_TO_JPG = false;
const INS_MIN_VIDEO_BYTES = 150 * 1024;
const INSTAGRAM_NET_URL_TTL_MS = 10 * 60 * 1000;
const INSTAGRAM_NET_URL_MAX_PER_TAB = 120;
```

## FAQ
- **Download failed**: Ensure you are logged in and the page is fully loaded; some sites require you to play the video first.
- **No media detected**: Confirm you are on a specific post page (not a feed or profile page).
