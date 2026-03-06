function collectMp4Candidates(obj, out) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) collectMp4Candidates(item, out);
    return;
  }

  const url = obj.url || obj.src || obj.download_url;
  if (typeof url === "string" && url.includes(".mp4")) {
    const bitrate = typeof obj.bitrate === "number" ? obj.bitrate : 0;
    out.push({ url, bitrate });
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "object") collectMp4Candidates(val, out);
    else if (typeof val === "string" && val.includes(".mp4")) {
      out.push({ url: val, bitrate: 0 });
    }
  }
}

async function fetchJson(url) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

function buildInsDownloadHeaders(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const origin = `${u.protocol}//${u.host}`;
    return [
      { name: "Referer", value: pageUrl },
      { name: "Origin", value: origin }
    ];
  } catch (err) {
    return [];
  }
}

async function waitDownloadEarlyResult(downloadId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    function finish(result) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch (err) {
        // ignore
      }
      resolve(result);
    }

    function validateCompletedDownload() {
      chrome.downloads.search({ id: downloadId }, (items) => {
        if (chrome.runtime.lastError) {
          finish({ ok: true, state: "complete" });
          return;
        }
        const item = items && items[0] ? items[0] : null;
        if (!item) {
          finish({ ok: false, error: "MISSING_ITEM" });
          return;
        }
        const size = typeof item.fileSize === "number"
          ? item.fileSize
          : (typeof item.bytesReceived === "number" ? item.bytesReceived : 0);
        const mime = String(item.mime || "").toLowerCase();
        if (mime && (mime.startsWith("text/") || mime.includes("html") || mime.includes("json"))) {
          finish({ ok: false, error: "BAD_MIME" });
          return;
        }
        if (size > 0 && size < INS_MIN_VIDEO_BYTES) {
          finish({ ok: false, error: "FILE_TOO_SMALL" });
          return;
        }
        finish({ ok: true, state: "complete" });
      });
    }

    function onChanged(delta) {
      if (!delta || delta.id !== downloadId) return;
      if (delta.error && delta.error.current) {
        finish({ ok: false, error: delta.error.current });
        return;
      }
      if (delta.state && delta.state.current === "interrupted") {
        finish({ ok: false, error: "INTERRUPTED" });
        return;
      }
      if (delta.state && delta.state.current === "complete") {
        validateCompletedDownload();
        return;
      }
    }

    try {
      chrome.downloads.onChanged.addListener(onChanged);
    } catch (err) {
      resolve({ ok: true, state: "unknown" });
      return;
    }

    timer = setTimeout(() => finish({ ok: true, state: "in_progress" }), timeoutMs);
  });
}

function pickBest(candidates) {
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.bitrate - a.bitrate);
  return candidates[0].url;
}

function pickBestMp4ByPath(candidates) {
  const byPath = new Map();
  for (const c of candidates || []) {
    if (!c || !c.url) continue;
    let key = "";
    try {
      const u = new URL(c.url);
      key = `${u.origin}${u.pathname}`;
    } catch (err) {
      key = String(c.url).split("?")[0];
    }
    const prev = byPath.get(key);
    if (!prev || (c.bitrate || 0) > (prev.bitrate || 0)) {
      byPath.set(key, c);
    }
  }
  return Array.from(byPath.values()).map((c) => c.url);
}

function normalizeTwitterImageDownloadUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("twimg.com")) return null;
    if (!u.pathname.includes("/media/")) return null;
    if (!u.searchParams.get("format")) {
      const m = u.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
      if (m) u.searchParams.set("format", m[1].toLowerCase());
    }
    u.searchParams.set("name", "orig");
    return u.toString();
  } catch (err) {
    return null;
  }
}

function collectTwitterImageCandidates(obj, out) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectTwitterImageCandidates(item, out);
    return;
  }

  const maybeUrls = [obj.url, obj.src, obj.media_url, obj.media_url_https];
  for (const maybe of maybeUrls) {
    if (typeof maybe !== "string") continue;
    const normalized = normalizeTwitterImageDownloadUrl(maybe);
    if (normalized) out.push(normalized);
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "object") collectTwitterImageCandidates(val, out);
  }
}

const IMAGE_MIN_BYTES = 10 * 1024;
const MAX_IMAGE_DOWNLOADS = 20;
const CONVERT_WEBP_TO_JPG = false;
const INS_MIN_VIDEO_BYTES = 150 * 1024;
const INSTAGRAM_NET_URL_TTL_MS = 10 * 60 * 1000;
const INSTAGRAM_NET_URL_MAX_PER_TAB = 120;
const recentInstagramVideoUrlsByTab = new Map();

function normalizeInstagramNetworkVideoUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const knownHost = host.endsWith("instagram.com") || host.includes("cdninstagram") || host.includes("fbcdn");
    if (!knownHost) return "";

    const full = `${u.pathname}${u.search}`.toLowerCase();
    if (full.includes("dashinit")) return "";
    const looksVideo = /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(full) ||
      full.includes("mime_type=video") ||
      full.includes("videoplayback");
    if (!looksVideo) return "";

    u.hash = "";
    return u.toString();
  } catch (err) {
    return "";
  }
}

function rememberInstagramVideoUrl(tabId, rawUrl) {
  if (typeof tabId !== "number" || tabId < 0) return;
  const normalized = normalizeInstagramNetworkVideoUrl(rawUrl);
  if (!normalized) return;

  const now = Date.now();
  const existing = recentInstagramVideoUrlsByTab.get(tabId) || [];
  const filtered = existing
    .filter((item) => item && typeof item.url === "string" && now - item.ts <= INSTAGRAM_NET_URL_TTL_MS)
    .filter((item) => item.url !== normalized);

  filtered.push({ url: normalized, ts: now });
  if (filtered.length > INSTAGRAM_NET_URL_MAX_PER_TAB) {
    filtered.splice(0, filtered.length - INSTAGRAM_NET_URL_MAX_PER_TAB);
  }
  recentInstagramVideoUrlsByTab.set(tabId, filtered);
}

function getRecentInstagramVideoUrls(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return [];
  const now = Date.now();
  const existing = recentInstagramVideoUrlsByTab.get(tabId) || [];
  const filtered = existing.filter((item) => item && typeof item.url === "string" && now - item.ts <= INSTAGRAM_NET_URL_TTL_MS);
  recentInstagramVideoUrlsByTab.set(tabId, filtered);
  return filtered.map((item) => item.url);
}

function extFromContentType(ct) {
  if (!ct) return "";
  const v = ct.split(";")[0].trim().toLowerCase();
  if (v === "image/jpeg") return "jpg";
  if (v === "image/png") return "png";
  if (v === "image/gif") return "gif";
  if (v === "image/webp") return "webp";
  if (v === "image/bmp") return "bmp";
  if (v === "image/avif") return "avif";
  if (v === "image/heic") return "heic";
  return "";
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : "";
  } catch (err) {
    return "";
  }
}

function sanitizePart(s) {
  const v = String(s || "").trim();
  if (!v) return "user";
  return v.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 50);
}

function buildBaseName(username, timestamp) {
  const u = sanitizePart(username);
  const t = String(timestamp || "").trim() || "time";
  return `${u}_${t}`;
}

function buildFolderName(username, publishTime) {
  const u = sanitizePart(username);
  const t = String(publishTime || "").trim() || "unknown_time";
  return `${u}_${t}`;
}

async function probeImage(url) {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (head.ok) {
      const ct = head.headers.get("content-type") || "";
      const len = parseInt(head.headers.get("content-length") || "0", 10);
      if (!ct.startsWith("image/")) return { ok: false, reason: "not_image" };
      if (len && len < IMAGE_MIN_BYTES) return { ok: false, reason: "too_small" };
      return { ok: true, contentType: ct, size: len, finalUrl: head.url || url };
    }
  } catch (err) {
    // ignore and try range GET
  }

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" }
    });
    if (!resp.ok) return { ok: false, reason: "http_error" };
    const ct = resp.headers.get("content-type") || "";
    const len = parseInt(resp.headers.get("content-length") || "0", 10);
    if (!ct.startsWith("image/")) return { ok: false, reason: "not_image" };
    if (len && len < IMAGE_MIN_BYTES) return { ok: false, reason: "too_small" };
    return { ok: true, contentType: ct, size: len, finalUrl: resp.url || url };
  } catch (err) {
    return { ok: false, reason: "fetch_failed" };
  }
}

async function convertWebpToJpgUrl(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const jpgBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    return URL.createObjectURL(jpgBlob);
  } catch (err) {
    return null;
  }
}

function tryXhsJpgUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (!url.includes("xhscdn.com")) return null;
  if (url.includes("_webp_")) return url.replace("_webp_", "_jpg_");
  if (url.includes("format/webp")) return url.replace("format/webp", "format/jpg");
  if (url.includes("format=webp")) return url.replace("format=webp", "format=jpg");
  return null;
}

function getTwitterProviderUrls(tweetId) {
  return [
    { name: "vxtwitter", url: `https://api.vxtwitter.com/status/${tweetId}` },
    { name: "fxtwitter", url: `https://api.fxtwitter.com/status/${tweetId}` }
  ];
}

function getTwitterMediaCounts(json) {
  const videoCandidates = [];
  collectMp4Candidates(json, videoCandidates);
  const imageCandidates = [];
  collectTwitterImageCandidates(json, imageCandidates);
  return { videoCount: videoCandidates.length, imageCount: imageCandidates.length };
}

async function fetchTwitterJsonWithFallback(tweetId, options = {}) {
  const requireVideo = !!options.requireVideo;
  const requireAnyMedia = !!options.requireAnyMedia;
  let lastError = "";

  for (const provider of getTwitterProviderUrls(tweetId)) {
    try {
      const data = await fetchJson(provider.url);
      if (requireVideo || requireAnyMedia) {
        const counts = getTwitterMediaCounts(data);
        if (requireVideo && counts.videoCount === 0) {
          lastError = `${provider.name}: no_video`;
          continue;
        }
        if (requireAnyMedia && counts.videoCount === 0 && counts.imageCount === 0) {
          lastError = `${provider.name}: no_media`;
          continue;
        }
      }
      return { json: data, provider: provider.name };
    } catch (err) {
      lastError = `${provider.name}: ${err && err.message ? err.message : String(err)}`;
    }
  }

  throw new Error(`Twitter解析失败，已自动尝试vxtwitter/fxtwitter。${lastError}`);
}

function buildXhsUrl(pageUrl) {
  const enc = encodeURIComponent(pageUrl);
  return `https://api.bugpk.com/api/xhs?url=${enc}`;
}

function canonicalizeInstagramPostUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.endsWith("instagram.com")) return rawUrl;
    const m = u.pathname.match(/\/(p|reel)\/([^/?#]+)/i);
    if (!m) return rawUrl;
    return `https://www.instagram.com/${m[1].toLowerCase()}/${m[2]}/`;
  } catch (err) {
    return rawUrl;
  }
}

function buildInstagramUrl(pageUrl) {
  const enc = encodeURIComponent(canonicalizeInstagramPostUrl(pageUrl));
  return `https://api.bugpk.com/api/short_videos?url=${enc}`;
}

function collectInstagramVideoCandidates(json, out) {
  if (!json || typeof json !== "object") return;
  const data = json.data && typeof json.data === "object" ? json.data : null;
  const directFields = data
    ? [data.url, data.video, data.video_url, data.play, data.play_url]
    : [json.url, json.video, json.video_url];
  for (const field of directFields) {
    if (typeof field === "string" && field.includes(".mp4")) {
      out.push({ url: field, bitrate: 9999 });
    }
  }
  collectMp4Candidates(json, out);
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    try {
      if (!details || typeof details.tabId !== "number" || details.tabId < 0) return;
      if (typeof details.statusCode === "number" && details.statusCode >= 400) return;
      rememberInstagramVideoUrl(details.tabId, details.url || "");
    } catch (err) {
      // ignore
    }
  },
  {
    urls: [
      "*://*.instagram.com/*",
      "*://*.cdninstagram.com/*",
      "*://*.fbcdn.net/*",
      "*://*.fna.fbcdn.net/*",
      "*://*.scontent.cdninstagram.com/*"
    ]
  }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    recentInstagramVideoUrlsByTab.delete(tabId);
  } catch (err) {
    // ignore
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    try {
      if (msg.type === "get_instagram_network_videos") {
        const tabId = typeof msg.tabId === "number" ? msg.tabId : -1;
        const urls = getRecentInstagramVideoUrls(tabId);
        sendResponse({ ok: true, urls });
        return;
      }

      if (msg.type === "download_images") {
        const urls = Array.isArray(msg.urls) ? msg.urls : [];
        let downloaded = 0;
        let skipped = 0;
        let index = typeof msg.startIndex === "number" ? msg.startIndex : 0;
        let processed = 0;
        const seen = new Set(Array.isArray(msg.knownDedupeKeys) ? msg.knownDedupeKeys : []);
        const baseName = buildBaseName(msg.username, msg.timestamp);
        const folder = buildFolderName(msg.username, msg.publishTime);

        for (const url of urls) {
          if (downloaded >= MAX_IMAGE_DOWNLOADS) {
            skipped += Math.max(0, urls.length - processed);
            break;
          }
          const probe = await probeImage(url);
          if (!probe.ok) {
            skipped += 1;
            index += 1;
            processed += 1;
            continue;
          }

          const dedupeKey = probe.finalUrl || url;
          if (seen.has(dedupeKey)) {
            skipped += 1;
            index += 1;
            processed += 1;
            continue;
          }

          let ext = extFromContentType(probe.contentType) || extFromUrl(url) || "jpg";
          let downloadUrl = url;
          if (CONVERT_WEBP_TO_JPG && ext === "webp") {
            const converted = await convertWebpToJpgUrl(url);
            if (converted) {
              downloadUrl = converted;
              ext = "jpg";
            } else {
              const alt = tryXhsJpgUrl(url);
              if (alt) {
                const altProbe = await probeImage(alt);
                if (altProbe.ok) {
                  downloadUrl = alt;
                  ext = extFromContentType(altProbe.contentType) || "jpg";
                }
              }
            }
          }
          const filename = `${folder}/${baseName}_${String(index + 1).padStart(3, "0")}.${ext}`;
          try {
            const id = await chrome.downloads.download({ url: downloadUrl, filename, saveAs: false });
            if (id) {
              downloaded += 1;
              seen.add(dedupeKey);
            } else {
              skipped += 1;
            }
          } catch (err) {
            skipped += 1;
          } finally {
            if (downloadUrl && downloadUrl.startsWith("blob:")) {
              try { URL.revokeObjectURL(downloadUrl); } catch (e) {}
            }
          }
          index += 1;
          processed += 1;
        }

        sendResponse({ ok: true, downloaded, skipped, knownDedupeKeys: Array.from(seen) });
        return;
      }

      let json;
      let filename = "video_download.mp4";
      const baseName = buildBaseName(msg.username, msg.timestamp);
      const folder = buildFolderName(msg.username, msg.publishTime);

      if (msg.type === "download_twitter_post_media") {
        const resolved = await fetchTwitterJsonWithFallback(msg.tweetId, { requireAnyMedia: true });
        json = resolved.json;

        const imageCandidates = [];
        collectTwitterImageCandidates(json, imageCandidates);
        const uniqueImageCandidates = Array.from(new Set(imageCandidates));
        const imageSeen = new Set();
        let downloadedImages = 0;
        let skippedImages = 0;
        let imageIndex = 1;

        for (const imageUrl of uniqueImageCandidates) {
          const probe = await probeImage(imageUrl);
          if (!probe.ok) {
            skippedImages += 1;
            continue;
          }
          const key = probe.finalUrl || imageUrl;
          if (imageSeen.has(key)) {
            skippedImages += 1;
            continue;
          }
          imageSeen.add(key);
          const ext = extFromContentType(probe.contentType) || extFromUrl(imageUrl) || "jpg";
          const imageFilename = `${folder}/${baseName}_img_${String(imageIndex).padStart(3, "0")}.${ext}`;
          try {
            const id = await chrome.downloads.download({ url: imageUrl, filename: imageFilename, saveAs: false });
            if (id) downloadedImages += 1;
            else skippedImages += 1;
          } catch (err) {
            skippedImages += 1;
          }
          imageIndex += 1;
        }

        const videoCandidates = [];
        collectMp4Candidates(json, videoCandidates);
        const videoUrls = pickBestMp4ByPath(videoCandidates);
        let downloadedVideos = 0;
        let skippedVideos = 0;
        let videoIndex = 1;
        for (const videoUrl of videoUrls) {
          const videoFilename = `${folder}/${baseName}_vid_${String(videoIndex).padStart(3, "0")}.mp4`;
          try {
            const id = await chrome.downloads.download({ url: videoUrl, filename: videoFilename, saveAs: false });
            if (id) downloadedVideos += 1;
            else skippedVideos += 1;
          } catch (err) {
            skippedVideos += 1;
          }
          videoIndex += 1;
        }

        if (!downloadedImages && !downloadedVideos) {
          throw new Error("未找到可下载的帖子媒体（图片或视频）");
        }
        sendResponse({
          ok: true,
          downloadedImages,
          skippedImages,
          downloadedVideos,
          skippedVideos,
          provider: resolved.provider
        });
        return;
      } else if (msg.type === "download_twitter") {
        const twitterResolved = await fetchTwitterJsonWithFallback(msg.tweetId, { requireVideo: true });
        json = twitterResolved.json;
        filename = `${folder}/${baseName}.mp4`;
      } else if (msg.type === "download_instagram") {
        const providerUrl = buildInstagramUrl(msg.pageUrl);
        json = await fetchJson(providerUrl);
        if (json && typeof json === "object") {
          const code = typeof json.code === "number" ? json.code : parseInt(String(json.code || ""), 10);
          if (!Number.isNaN(code) && code !== 200) {
            throw new Error(json.msg || json.message || `INS解析失败(code=${code})`);
          }
        }
        filename = `${folder}/${baseName}.mp4`;

        const candidates = [];
        collectInstagramVideoCandidates(json, candidates);
        const bestUrl = pickBest(candidates);
        if (!bestUrl) {
          throw new Error("固定INS解析器未返回可下载视频链接");
        }

        const insHeaders = buildInsDownloadHeaders(msg.pageUrl || "");
        let downloadId = null;
        if (insHeaders.length) {
          try {
            downloadId = await chrome.downloads.download({
              url: bestUrl,
              filename,
              saveAs: false,
              headers: insHeaders
            });
          } catch (err) {
            // fallback to plain request
          }
        }
        if (!downloadId) {
          downloadId = await chrome.downloads.download({
            url: bestUrl,
            filename,
            saveAs: false
          });
        }
        if (!downloadId) {
          throw new Error("下载未能启动，请检查下载权限或链接是否可访问");
        }
        const early = await waitDownloadEarlyResult(downloadId, 8000);
        if (!early.ok) {
          throw new Error(`下载启动失败(${early.error || "UNKNOWN"})`);
        }

        sendResponse({
          ok: true,
          filename,
          provider: "bugpk_short_videos"
        });
        return;
      } else if (msg.type === "download_xhs") {
        const providerUrl = buildXhsUrl(msg.pageUrl);
        json = await fetchJson(providerUrl);
        filename = `${folder}/${baseName}.mp4`;
      } else {
        sendResponse({ ok: false, error: "unsupported_request" });
        return;
      }

      const candidates = [];
      collectMp4Candidates(json, candidates);

      const bestUrl = pickBest(candidates);
      if (!bestUrl) {
        throw new Error("未找到视频链接，可能该推文没有视频或解析服务失败");
      }

      const downloadId = await chrome.downloads.download({
        url: bestUrl,
        filename,
        saveAs: false
      });
      if (!downloadId) {
        throw new Error("下载未能启动，请检查下载权限或链接是否可访问");
      }

      sendResponse({
        ok: true,
        filename
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      sendResponse({ ok: false, error: msg });
    }
  })();

  return true; // async response
});
