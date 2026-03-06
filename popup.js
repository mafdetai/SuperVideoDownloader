const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("downloadBtn");
const downloadImagesBtn = document.getElementById("downloadImagesBtn");
const downloadImagesPreciseBtn = document.getElementById("downloadImagesPreciseBtn");
const batchControlsEl = document.getElementById("batchControls");
const continueBatchBtn = document.getElementById("continueBatchBtn");
const stopBatchBtn = document.getElementById("stopBatchBtn");

const BATCH_SIZE = 20;
const BATCH_STATE_TTL_MS = 0;
const INS_MIN_VIDEO_BYTES = 150 * 1024;
let pendingQueue = null;
let pendingIndex = 0;
let pendingMeta = null;
let totalDownloaded = 0;
let totalSkipped = 0;
let pendingTotal = 0;
let knownDedupeKeys = [];
let isBatchDownloading = false;
let batchStateSaveQueue = Promise.resolve();

function setStatus(msg) {
  statusEl.textContent = msg;
}

function showBatchControls(show) {
  batchControlsEl.style.display = show ? "block" : "none";
}

async function saveBatchState() {
  if (!pendingQueue || !pendingQueue.length) {
    await chrome.storage.local.remove(["batchState"]);
    return;
  }
  await chrome.storage.local.set({
    batchState: {
      queue: pendingQueue,
      index: pendingIndex,
      meta: pendingMeta,
      downloaded: totalDownloaded,
      skipped: totalSkipped,
      knownDedupeKeys,
      updatedAt: Date.now()
    }
  });
}

function queueSaveBatchState() {
  batchStateSaveQueue = batchStateSaveQueue
    .then(() => saveBatchState())
    .catch(() => {});
  return batchStateSaveQueue;
}

async function restoreBatchState() {
  const stored = await chrome.storage.local.get(["batchState"]);
  if (!stored.batchState) return false;
  const st = stored.batchState;
  if (!Array.isArray(st.queue) || typeof st.index !== "number") return false;
  if (BATCH_STATE_TTL_MS > 0 &&
      typeof st.updatedAt === "number" &&
      Date.now() - st.updatedAt > BATCH_STATE_TTL_MS) {
    await chrome.storage.local.remove(["batchState"]);
    return false;
  }
  pendingQueue = st.queue;
  pendingIndex = st.index;
  pendingMeta = st.meta || null;
  totalDownloaded = st.downloaded || 0;
  totalSkipped = st.skipped || 0;
  knownDedupeKeys = Array.isArray(st.knownDedupeKeys) ? st.knownDedupeKeys : [];
  pendingTotal = pendingQueue.length;

  if (pendingIndex < pendingTotal) {
    setStatus(
      `已下载：${totalDownloaded} 张，已跳过：${totalSkipped} 张\n` +
      `是否继续下载下一批？`
    );
    showBatchControls(true);
    return true;
  }
  return false;
}

function parseTweetId(url) {
  if (!url) return null;
  const m = url.match(/\/status\/(\d+)/) || url.match(/\/statuses\/(\d+)/) || url.match(/\/i\/status\/(\d+)/);
  return m ? m[1] : null;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isTwitterHost(host) {
  return host.endsWith("twitter.com") || host.endsWith("x.com");
}

function isXhsHost(host) {
  return host.endsWith("xiaohongshu.com") || host.endsWith("xhslink.com");
}

function isInstagramHost(host) {
  return host.endsWith("instagram.com");
}

function isXhsPostUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("xiaohongshu.com")) return false;
    return /\/(explore|discovery\/item)\//i.test(u.pathname);
  } catch (err) {
    return false;
  }
}

function isInstagramPostUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("instagram.com")) return false;
    return /\/(p|reel)\/[^/?#]+/i.test(u.pathname);
  } catch (err) {
    return false;
  }
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

function isLikelyXhsImageUrl(url) {
  if (!url) return false;
  if (url.startsWith("data:")) return false;
  if (url.includes("sns-avatar") || url.includes("/avatar/")) return false;
  if (url.includes("profile_images")) return false;
  if (url.includes("emoji") || url.includes("hashflags")) return false;
  return url.includes("xhscdn.com") || url.includes("xiaohongshu.com");
}

function isTwitterMediaPageUrl(url) {
  try {
    const u = new URL(url);
    if (!isTwitterHost(u.hostname)) return false;
    return /\/media(\/|$)/i.test(u.pathname);
  } catch (err) {
    return false;
  }
}

function formatTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function formatDateOnly(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sanitizePart(s) {
  const v = String(s || "").trim();
  if (!v) return "user";
  return v.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 50);
}

function buildFolderName(username, publishTime) {
  const u = sanitizePart(username);
  const t = String(publishTime || "").trim() || "unknown_time";
  return `${u}_${t}`;
}

function instagramVideoDedupeKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    u.hash = "";
    u.searchParams.delete("bytestart");
    u.searchParams.delete("byteend");
    return `${u.origin}${u.pathname}`;
  } catch (err) {
    return String(url || "").split("?")[0];
  }
}

function instagramVideoScore(url) {
  const s = String(url || "").toLowerCase();
  let score = 0;
  if (s.startsWith("https://") || s.startsWith("http://")) score += 20;
  if (s.includes(".mp4")) score += 50;
  if (s.includes("cdninstagram.com") || s.includes("fbcdn.net")) score += 30;
  if (!s.includes("bytestart=") && !s.includes("byteend=")) score += 20;
  if (s.includes("oe=")) score += 5;
  if (s.includes(".m3u8") || s.includes("manifest") || s.includes("dash")) score -= 80;
  return score;
}

function pickInstagramBestVideos(urls, maxCount = 1) {
  const byKey = new Map();
  let index = 0;
  for (const raw of urls || []) {
    const url = String(raw || "").trim();
    if (!url) continue;
    const key = instagramVideoDedupeKey(url) || url;
    const score = instagramVideoScore(url);
    const prev = byKey.get(key);
    if (!prev || score > prev.score || (score === prev.score && index > prev.index)) {
      byKey.set(key, { url, score, index });
    }
    index += 1;
  }
  const ranked = Array.from(byKey.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.index - a.index;
  });
  if (maxCount > 0) return ranked.slice(0, maxCount).map((item) => item.url);
  return ranked.map((item) => item.url);
}

function isInsImageLikeUrl(url) {
  const lower = String(url || "").toLowerCase();
  return /\.(jpg|jpeg|png|gif|webp|avif)(\?|#|$)/i.test(lower) ||
    /[?&](?:format|fm)=(?:jpg|jpeg|png|gif|webp|avif)\b/i.test(lower);
}

function isInsLikelyNetworkError(code) {
  const v = String(code || "").toUpperCase();
  return v.includes("NETWORK") || v.includes("SERVER") || v.includes("HTTP");
}

function explainInsDownloadError(code) {
  const v = String(code || "").toUpperCase();
  if (!v) return "未知错误（可能是站点限制或链接失效）";
  if (v.includes("SERVER_FORBIDDEN")) return "站点拒绝下载（常见于防盗链或权限限制）";
  if (v.includes("SERVER_UNAUTHORIZED")) return "未授权访问该视频（需登录或权限不足）";
  if (v.includes("SERVER_BAD_CONTENT")) return "返回内容异常（可能不是可直下视频流）";
  if (v.includes("SERVER_FAILED")) return "服务器响应失败（可能是限流或临时故障）";
  if (v.includes("NETWORK_FAILED")) return "网络请求失败（也可能被站点策略拦截）";
  if (v.includes("NETWORK_TIMEOUT")) return "请求超时（可能连接慢或站点拦截）";
  if (v.includes("NETWORK_INVALID_REQUEST")) return "请求被拒绝（请求头或来源不被接受）";
  if (v.includes("FILE_NO_SPACE")) return "磁盘空间不足";
  if (v.includes("FILE_ACCESS_DENIED")) return "下载目录无写入权限";
  if (v.includes("FILE_TOO_SMALL")) return "下载文件过小（可能是分片或错误页）";
  if (v.includes("BAD_MIME")) return "下载内容不是视频（可能被站点拦截）";
  if (v.includes("INTERRUPTED")) return "下载被中断";
  if (v.includes("NO_DOWNLOAD_ID")) return "浏览器未创建下载任务";
  return "下载失败（可能是站点限制、链接过期或权限问题）";
}

async function validateCompletedInsDownload(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: true });
        return;
      }
      const item = items && items[0] ? items[0] : null;
      if (!item) {
        resolve({ ok: false, error: "MISSING_ITEM" });
        return;
      }
      const size = typeof item.fileSize === "number"
        ? item.fileSize
        : (typeof item.bytesReceived === "number" ? item.bytesReceived : 0);
      const mime = String(item.mime || "").toLowerCase();
      if (mime && (mime.startsWith("text/") || mime.includes("html") || mime.includes("json"))) {
        resolve({ ok: false, error: "BAD_MIME" });
        return;
      }
      if (size > 0 && size < INS_MIN_VIDEO_BYTES) {
        resolve({ ok: false, error: "FILE_TOO_SMALL" });
        return;
      }
      resolve({ ok: true });
    });
  });
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
        validateCompletedInsDownload(downloadId)
          .then((check) => {
            if (check && check.ok) finish({ ok: true, state: "complete" });
            else finish({ ok: false, error: (check && check.error) ? check.error : "INVALID_FILE" });
          })
          .catch(() => finish({ ok: true, state: "complete" }));
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

async function triggerInsPageDownload(tabId, url, filename) {
  try {
    const baseName = String(filename || "ins_video.mp4").split("/").pop();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url, baseName],
      func: (downloadUrl, downloadName) => {
        try {
          const a = document.createElement("a");
          a.href = downloadUrl;
          a.download = downloadName || "ins_video.mp4";
          a.rel = "noopener noreferrer";
          a.target = "_blank";
          document.body.appendChild(a);
          a.click();
          a.remove();
          return true;
        } catch (err) {
          return false;
        }
      }
    });
    return !!(results && results[0] && results[0].result);
  } catch (err) {
    return false;
  }
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

async function tryInsDirectDownload(videoUrl, filename, pageUrl) {
  const headers = buildInsDownloadHeaders(pageUrl);
  const baseOptions = { url: videoUrl, filename, saveAs: false };

  let downloadId = null;
  let usedHeaders = false;

  if (headers.length) {
    try {
      downloadId = await chrome.downloads.download({ ...baseOptions, headers });
      if (downloadId) usedHeaders = true;
    } catch (err) {
      // fallback to request without headers
    }
  }

  if (!downloadId) {
    try {
      downloadId = await chrome.downloads.download(baseOptions);
    } catch (err) {
      return {
        ok: false,
        errorCode: "EXCEPTION",
        errorMessage: err && err.message ? err.message : "下载请求异常",
        usedHeaders
      };
    }
  }

  if (!downloadId) {
    return {
      ok: false,
      errorCode: "NO_DOWNLOAD_ID",
      errorMessage: "浏览器未返回下载任务ID",
      usedHeaders
    };
  }

  const early = await waitDownloadEarlyResult(downloadId, 8000);
  if (!early.ok) {
    const code = early && early.error ? String(early.error) : "UNKNOWN_ERROR";
    return {
      ok: false,
      errorCode: code,
      errorMessage: explainInsDownloadError(code),
      usedHeaders
    };
  }

  return { ok: true, usedHeaders };
}

async function getInstagramNetworkVideoUrls(tabId) {
  if (typeof tabId !== "number" || tabId < 0) return [];
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "get_instagram_network_videos", tabId },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        if (!resp || !resp.ok || !Array.isArray(resp.urls)) {
          resolve([]);
          return;
        }
        resolve(resp.urls.map((u) => String(u || "").trim()).filter(Boolean));
      }
    );
  });
}

async function downloadInstagramVideoByLocalFallback(tabId, pageUrl, timestamp, username, publishTime) {
  const candidates = await getInstagramPostVideoUrls(tabId);
  const uniq = Array.from(new Set((candidates || []).map((u) => String(u || "").trim()).filter(Boolean)));
  const httpCandidates = uniq.filter((u) => u.startsWith("http://") || u.startsWith("https://"));
  const blobCandidates = uniq.filter((u) => u.startsWith("blob:"));
  let filteredRaw = httpCandidates.length ? httpCandidates : blobCandidates;
  let usedNetworkCaptureCandidates = false;

  if (!httpCandidates.length) {
    const networkUrls = await getInstagramNetworkVideoUrls(tabId);
    if (networkUrls.length) {
      filteredRaw = networkUrls;
      usedNetworkCaptureCandidates = true;
    }
  }

  const filtered = pickInstagramBestVideos(filteredRaw, 8);

  if (!filtered.length) {
    return { ok: false, error: "未检测到可下载的INS视频（本地兜底）" };
  }

  const safeUser = sanitizePart(username);
  const folder = buildFolderName(safeUser, publishTime);
  let downloaded = 0;
  let skipped = 0;
  let idx = 1;
  let lastErrorCode = "";
  let lastErrorMessage = "";
  let usedHeaderDirect = false;
  let manualOpenTriggered = false;

  for (const videoUrl of filtered) {
    if (downloaded >= 1) break;
    if (isInsImageLikeUrl(videoUrl)) {
      skipped += 1;
      lastErrorCode = "IMAGE_URL_FILTERED";
      lastErrorMessage = "候选链接被识别为图片地址";
      idx += 1;
      continue;
    }
    const suffix = filtered.length > 1 ? `_vid_${String(idx).padStart(3, "0")}` : "";
    const filename = `${folder}/${safeUser}_${timestamp}${suffix}.mp4`;

    const direct = await tryInsDirectDownload(videoUrl, filename, pageUrl);
    if (direct.ok) {
      downloaded += 1;
      if (direct.usedHeaders) usedHeaderDirect = true;
      idx += 1;
      continue;
    }
    lastErrorCode = direct.errorCode || "UNKNOWN_ERROR";
    lastErrorMessage = direct.errorMessage || explainInsDownloadError(lastErrorCode);

    const manualOpen = await triggerInsPageDownload(tabId, videoUrl, filename);
    if (manualOpen) {
      manualOpenTriggered = true;
    }
    skipped += 1;
    idx += 1;
  }

  if (!downloaded) {
    if (!httpCandidates.length && blobCandidates.length) {
      return {
        ok: false,
        error: "仅检测到blob视频地址，浏览器限制下无法直接下载。请先播放视频后重试。"
      };
    }
    const reasonText = explainInsDownloadError(lastErrorCode);
    const detail = lastErrorMessage ? `；细节：${lastErrorMessage}` : "";
    const manualHint = manualOpenTriggered ? "；已尝试打开页面下载（未确认真实下载任务）" : "";
    return { ok: false, error: `本地兜底失败：${reasonText}${detail}${manualHint}` };
  }

  let modeText = "";
  if (usedHeaderDirect) {
    modeText = "已使用带来源头直连下载。";
  } else {
    modeText = "已使用直连下载。";
  }
  if (usedNetworkCaptureCandidates) modeText += " 使用了网络抓包候选。";
  if (manualOpenTriggered) modeText += " 并尝试过页面打开兜底。";

  return { ok: true, downloaded, skipped, modeText };
}

async function getUsernameFromPage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        const url = new URL(location.href);
        if (url.hostname.endsWith("x.com") || url.hostname.endsWith("twitter.com")) {
          const segs = url.pathname.split("/").filter(Boolean);
          if (segs.length >= 2 && (segs[1] === "status" || segs[1] === "statuses")) {
            return segs[0];
          }
        }
        if (url.hostname.endsWith("instagram.com")) {
          try {
            const segs = url.pathname.split("/").filter(Boolean);
            if (segs.length === 1 && segs[0] && !["explore", "accounts", "reel", "p", "tagged", "reels"].includes(segs[0])) {
              return segs[0];
            }
          } catch (err) {
            // ignore
          }

          try {
            const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
            const article = document.querySelector("article");
            const root = dialog || article || document;
            const anchors = Array.from(root.querySelectorAll('a[href^="/"]'));
            for (const a of anchors) {
              const href = a.getAttribute("href") || "";
              if (!/^\/[A-Za-z0-9._]+\/$/.test(href)) continue;
              const name = href.replace(/\//g, "");
              if (!name) continue;
              if (name === "explore" || name === "accounts" || name === "reel" || name === "p") continue;
              return name;
            }
          } catch (err) {
            // ignore
          }

          const ogDesc = document.querySelector('meta[property="og:description"]');
          if (ogDesc && ogDesc.content) {
            const m = ogDesc.content.match(/@([A-Za-z0-9._]+)/);
            if (m) return m[1];
          }
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle && ogTitle.content) {
            const m = ogTitle.content.match(/^([A-Za-z0-9._]+)\s/);
            if (m) return m[1];
            const m2 = ogTitle.content.match(/@([A-Za-z0-9._]+)/);
            if (m2) return m2[1];
          }
          const metaDesc = document.querySelector('meta[name="description"]');
          if (metaDesc && metaDesc.content) {
            const m = metaDesc.content.match(/@([A-Za-z0-9._]+)/);
            if (m) return m[1];
          }
          const ldJsonList = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const el of ldJsonList) {
            try {
              const data = JSON.parse(el.textContent || "");
              const author = data && data.author ? data.author : null;
              if (author && typeof author === "object") {
                if (author.alternateName) return String(author.alternateName).replace(/^@/, "");
                if (author.name) return String(author.name).replace(/^@/, "");
              }
              if (data && data.creator && data.creator.alternateName) {
                return String(data.creator.alternateName).replace(/^@/, "");
              }
            } catch (err) {
              // ignore
            }
          }
        }
        if (url.hostname.endsWith("xiaohongshu.com")) {
          try {
            const nameEl = document.querySelector('[data-testid*="user-name"], [class*="author"], [class*="user-name"]');
            if (nameEl && nameEl.textContent) {
              const t = nameEl.textContent.trim();
              if (t) return t;
            }
          } catch (err) {
            // ignore
          }

          try {
            const anchors = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'));
            for (const a of anchors) {
              const t = (a.textContent || "").trim();
              if (t && t.length <= 30) return t;
            }
          } catch (err) {
            // ignore
          }

          const ogDesc = document.querySelector('meta[property="og:description"]');
          if (ogDesc && ogDesc.content) {
            const m = ogDesc.content.match(/@([A-Za-z0-9._-]+)/);
            if (m) return m[1];
          }
          const ogTitle = document.querySelector('meta[property="og:title"]');
          if (ogTitle && ogTitle.content) {
            const m = ogTitle.content.match(/^(.+?)的/);
            if (m) return m[1].trim();
          }
        }
      } catch (err) {
        // ignore
      }

      const metaAuthor = document.querySelector('meta[name="author"]');
      if (metaAuthor && metaAuthor.content) return metaAuthor.content.trim();

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle && ogTitle.content) {
        const m = ogTitle.content.match(/@([A-Za-z0-9_\\.]+)/);
        if (m) return m[1];
      }

      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc && ogDesc.content) {
        const m = ogDesc.content.match(/@([A-Za-z0-9_\\.]+)/);
        if (m) return m[1];
      }

      return "";
    }
  });
  return result || "";
}

async function getPublishTimeFromPage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const timeEl = document.querySelector("time[datetime]");
      if (timeEl && timeEl.getAttribute("datetime")) {
        return timeEl.getAttribute("datetime");
      }
      return "";
    }
  });
  if (!result) return "";
  const d = new Date(result);
  if (Number.isNaN(d.getTime())) return "";
  return formatTimestamp(d);
}

async function getPageVideoUrls(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const urls = new Set();
      const videos = document.querySelectorAll("video");
      for (const v of videos) {
        if (v.currentSrc) urls.add(v.currentSrc);
        if (v.src) urls.add(v.src);
        const sources = v.querySelectorAll("source");
        for (const s of sources) {
          if (s.src) urls.add(s.src);
        }
      }
      return Array.from(urls);
    }
  });
  return result || [];
}

async function getInstagramPostVideoUrls(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async () => {
      function getShortcode() {
        try {
          const m = location.pathname.match(/\/(reel|p)\/([^/?#]+)/);
          return m ? m[2] : "";
        } catch (err) {
          return "";
        }
      }

      function normalizeCandidate(raw) {
        if (!raw || typeof raw !== "string") return "";
        let v = raw.trim();
        if (!v) return "";
        v = v.replace(/\\u0026/g, "&");
        v = v.replace(/\\\//g, "/");
        if (v.startsWith("//")) v = `${location.protocol}${v}`;
        if (v.startsWith("/")) {
          try {
            v = new URL(v, location.origin).toString();
          } catch (err) {
            return "";
          }
        }
        return v;
      }

      function isImageUrl(v) {
        return /\.(jpg|jpeg|png|gif|webp|avif)(\?|#|$)/i.test(v) ||
          /[?&](?:format|fm)=(?:jpg|jpeg|png|gif|webp|avif)\b/i.test(v);
      }

      function isLikelyVideoUrl(v) {
        if (/dashinit/i.test(v)) return false;
        return /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(v) ||
          /mime_type=video/i.test(v) ||
          /videoplayback|playback/i.test(v);
      }

      function addVideoCandidate(out, raw, fromVideoTag) {
        const v = normalizeCandidate(raw);
        if (!v) return;
        if (v.startsWith("blob:")) {
          out.add(v);
          return;
        }
        if (!/^https?:\/\//i.test(v)) return;
        if (isImageUrl(v)) return;
        if (fromVideoTag || isLikelyVideoUrl(v)) out.add(v);
      }

      function rankVideoElement(el) {
        if (!el || !el.getBoundingClientRect) return 0;
        try {
          const rect = el.getBoundingClientRect();
          const area = Math.max(0, (rect.width || 0) * (rect.height || 0));
          const activeBoost = (el.currentTime > 0 ? 1000000000 : 0) + (!el.paused ? 300000000 : 0);
          return area + activeBoost;
        } catch (err) {
          return 0;
        }
      }

      function collectFromVideoTags(root, out, maxCount) {
        if (!root) return;
        const all = Array.from(root.querySelectorAll("video"));
        all.sort((a, b) => rankVideoElement(b) - rankVideoElement(a));
        const selected = typeof maxCount === "number" && maxCount > 0 ? all.slice(0, maxCount) : all;
        for (const video of selected) {
          addVideoCandidate(out, video.currentSrc, true);
          addVideoCandidate(out, video.src, true);
          const sources = video.querySelectorAll("source");
          for (const source of sources) {
            addVideoCandidate(out, source.src, true);
          }
        }
      }

      function collectFromScriptText(text, out, shortcode) {
        if (!text) return;
        if (shortcode && !text.includes(shortcode)) return;
        const plainRe = /(https?:\/\/[^"'\\\s<>]+?\.(?:mp4|m4v|mov|webm)(?:\?[^"'\\\s<>]*)?)/ig;
        const escapedRe = /(https?:\\\/\\\/[^"'\\\s<>]+?\.(?:mp4|m4v|mov|webm)(?:\\u0026[^"'\\\s<>]*)?)/ig;
        const keyRe = /"(?:video_url|playback_url|playbackUrl|contentUrl)"\s*:\s*"([^"]+)"/ig;
        let m;
        while ((m = plainRe.exec(text)) !== null) addVideoCandidate(out, m[1], false);
        while ((m = escapedRe.exec(text)) !== null) addVideoCandidate(out, m[1], false);
        while ((m = keyRe.exec(text)) !== null) addVideoCandidate(out, m[1], false);
      }

      const shortcode = getShortcode();
      const urls = new Set();
      const main = document.querySelector("main");
      const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
      let scopeRoot = null;

      if (shortcode) {
        const selector = `a[href*="/p/${shortcode}/"], a[href*="/reel/${shortcode}/"]`;
        const anchors = Array.from(document.querySelectorAll(selector));
        for (const anchor of anchors) {
          const article = anchor.closest("article");
          if (article) {
            scopeRoot = article;
            break;
          }
        }
      }
      if (!scopeRoot && dialog) scopeRoot = dialog;
      if (!scopeRoot && main) scopeRoot = main;
      if (!scopeRoot) scopeRoot = document;

      collectFromVideoTags(scopeRoot, urls, 2);
      if (!urls.size && dialog && dialog !== scopeRoot) collectFromVideoTags(dialog, urls, 2);
      if (!urls.size && main && main !== scopeRoot) collectFromVideoTags(main, urls, 2);

      const metaVideoNodes = document.querySelectorAll(
        'meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[name="twitter:player:stream"]'
      );
      for (const node of metaVideoNodes) {
        addVideoCandidate(urls, node && node.content ? node.content : "", false);
      }
      if (urls.size) return Array.from(urls);

      const ldJsonScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const scriptEl of ldJsonScripts) {
        collectFromScriptText(scriptEl.textContent || "", urls, shortcode);
      }
      if (urls.size) return Array.from(urls);

      const scriptEls = Array.from(document.querySelectorAll("script"));
      const maxScripts = Math.min(scriptEls.length, 40);
      for (let i = 0; i < maxScripts; i += 1) {
        const text = scriptEls[i] && scriptEls[i].textContent ? scriptEls[i].textContent : "";
        if (!text || text.length > 1000000) continue;
        if (!(text.includes(".mp4") || text.includes("video_url") || text.includes("playback_url"))) continue;
        collectFromScriptText(text, urls, shortcode);
      }

      if (!urls.size) {
        try {
          const resources = performance.getEntriesByType("resource") || [];
          for (const entry of resources) {
            const name = entry && entry.name ? String(entry.name) : "";
            if (!name || name.startsWith("blob:")) continue;
            const lower = name.toLowerCase();
            if (lower.includes("dashinit")) continue;
            const looksVideo = lower.includes("mime_type=video") ||
              lower.includes("videoplayback") ||
              /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(lower);
            if (!looksVideo) continue;
            const fromKnownHost = lower.includes("instagram") || lower.includes("fbcdn");
            if (!fromKnownHost) continue;
            addVideoCandidate(urls, name, false);
          }
        } catch (err) {
          // ignore
        }
      }

      return Array.from(urls);
    }
  });

  const merged = [];
  for (const item of results || []) {
    if (Array.isArray(item.result)) merged.push(...item.result);
  }
  return merged;
}

async function getTwitterMediaImageUrlsByAutoScroll(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      function normalizeTwitterImage(url) {
        try {
          const u = new URL(url, location.href);
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

      function collectUrls(set) {
        const imgs = document.querySelectorAll("img");
        for (const img of imgs) {
          const candidates = [img.currentSrc, img.src];
          const srcset = img.getAttribute("srcset");
          if (srcset) {
            for (const part of srcset.split(",")) {
              const p = part.trim().split(/\s+/)[0];
              if (p) candidates.push(p);
            }
          }
          for (const c of candidates) {
            if (!c) continue;
            const n = normalizeTwitterImage(c);
            if (n) set.add(n);
          }
        }
      }

      const urls = new Set();
      let staleRounds = 0;
      let prevSize = 0;
      let lastY = -1;
      const maxRounds = 160;
      const waitMs = 700;

      for (let round = 0; round < maxRounds; round += 1) {
        collectUrls(urls);
        const currentSize = urls.size;
        const y = window.scrollY;
        const docHeight = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );
        const atBottom = y + window.innerHeight >= docHeight - 2;

        if (currentSize === prevSize) staleRounds += 1;
        else staleRounds = 0;
        prevSize = currentSize;

        if (staleRounds >= 8 && atBottom) break;
        if (staleRounds >= 16) break;

        const step = Math.max(window.innerHeight * 1.8, 900);
        window.scrollTo(0, y + step);
        await new Promise((resolve) => setTimeout(resolve, waitMs));

        if (lastY === window.scrollY && atBottom) staleRounds += 2;
        lastY = window.scrollY;
      }

      collectUrls(urls);
      return Array.from(urls);
    }
  });
  return result || [];
}

async function getTwitterPostImageUrlsPrecise(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function getStatusIdFromPath() {
        try {
          const m = location.pathname.match(/\/status\/(\d+)/);
          return m ? m[1] : "";
        } catch (err) {
          return "";
        }
      }

      function normalizeTwitterImage(url) {
        try {
          const u = new URL(url, location.href);
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

      function collectFromRoot(root, out) {
        if (!root) return;
        const imgs = root.querySelectorAll("img");
        for (const img of imgs) {
          const candidates = [img.currentSrc, img.src];
          const srcset = img.getAttribute("srcset");
          if (srcset) {
            for (const part of srcset.split(",")) {
              const p = part.trim().split(/\s+/)[0];
              if (p) candidates.push(p);
            }
          }
          for (const c of candidates) {
            if (!c) continue;
            const n = normalizeTwitterImage(c);
            if (n) out.add(n);
          }
        }
      }

      const statusId = getStatusIdFromPath();
      if (!statusId) return [];

      const urls = new Set();

      const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
      if (dialog) collectFromRoot(dialog, urls);

      if (!urls.size) {
        const links = Array.from(document.querySelectorAll(`a[href*="/status/${statusId}"]`));
        for (const link of links) {
          const article = link.closest("article");
          if (article) collectFromRoot(article, urls);
        }
      }

      if (!urls.size) {
        const mediaRoots = document.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="tweetMediaContainer"]');
        for (const root of mediaRoots) collectFromRoot(root, urls);
      }

      return Array.from(urls);
    }
  });
  return result || [];
}

async function getPageImageUrls(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function getInstagramShortcodeFromUrl() {
        try {
          const m = location.pathname.match(/\/(reel|p)\/([^/?#]+)/);
          return m ? m[2] : "";
        } catch (err) {
          return "";
        }
      }
      function getStatusIdFromUrl() {
        try {
          const m = location.pathname.match(/\/status\/(\d+)/);
          return m ? m[1] : "";
        } catch (err) {
          return "";
        }
      }
      function getXhsNoteIdFromUrl() {
        try {
          const m = location.pathname.match(/\/(explore|discovery\/item)\/([^/?#]+)/);
          return m ? m[2] : "";
        } catch (err) {
          return "";
        }
      }
      function pickLargestFromSrcset(srcset) {
        if (!srcset) return "";
        const candidates = srcset
          .split(",")
          .map((item) => item.trim())
          .map((item) => {
            const parts = item.split(/\s+/);
            const url = parts[0];
            let size = 0;
            const desc = parts[1] || "";
            const m = desc.match(/(\d+)(w|x)/i);
            if (m) size = parseInt(m[1], 10);
            return { url, size };
          })
          .filter((c) => c.url);
        if (!candidates.length) return "";
        candidates.sort((a, b) => b.size - a.size);
        return candidates[0].url;
      }

      function normalizeTwitterImage(url) {
        try {
          const u = new URL(url);
          if (!u.hostname.endsWith("twimg.com")) return { key: url, url };
          if (!u.pathname.includes("/media/")) return { key: url, url };

          const key = `${u.hostname}${u.pathname}`;
          const format = u.searchParams.get("format") || "";
          const name = u.searchParams.get("name") || "";

          return { key, url: u.toString(), format, name };
        } catch (err) {
          return { key: url, url };
        }
      }

      function twitterNameRank(name) {
        const n = String(name || "").toLowerCase();
        if (n === "orig") return 5;
        if (n === "4096x4096") return 4;
        if (n === "large") return 3;
        if (n === "medium") return 2;
        if (n === "small") return 1;
        if (n === "thumb") return 0;
        return 0;
      }

      function ensureLargestTwitterUrl(info) {
        if (!info || !info.url) return info;
        try {
          const u = new URL(info.url);
          if (!u.hostname.endsWith("twimg.com")) return info;
          if (!u.pathname.includes("/media/")) return info;

          if (!u.searchParams.get("format")) {
            const m = u.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
            if (m) u.searchParams.set("format", m[1].toLowerCase());
          }
          u.searchParams.set("name", "orig");
          return { ...info, url: u.toString(), name: "orig" };
        } catch (err) {
          return info;
        }
      }

      const urls = new Set();
      const twitterBestByKey = new Map();

      let scopeRoot = document;
      try {
        const host = location.hostname;
        if (host.endsWith("x.com") || host.endsWith("twitter.com")) {
          const main = document.querySelector("main");
          const statusId = getStatusIdFromUrl();
          if (statusId) {
            const selector = `a[href*="/status/${statusId}"]`;
            const link = main ? main.querySelector(selector) : document.querySelector(selector);
            const article = link ? link.closest("article") : null;
            if (article) scopeRoot = article;
          } else {
            const article = main ? main.querySelector("article") : document.querySelector("article");
            if (article) scopeRoot = article;
          }
        } else if (host.endsWith("instagram.com")) {
          const main = document.querySelector("main");
          const shortcode = getInstagramShortcodeFromUrl();
          const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
          if (shortcode) {
            if (dialog) {
              scopeRoot = dialog;
            } else {
              const selector = `a[href*="/reel/${shortcode}/"], a[href*="/p/${shortcode}/"]`;
              const link = main ? main.querySelector(selector) : document.querySelector(selector);
              const article = link ? link.closest("article") : null;
              if (article) scopeRoot = article;
            }
          }
          if (scopeRoot === document && main) {
            const article = main.querySelector("article");
            if (article) scopeRoot = article;
            else scopeRoot = main;
          }
        }
        else if (host.endsWith("xiaohongshu.com")) {
          const main = document.querySelector("main");
          const noteId = getXhsNoteIdFromUrl();
          if (noteId) {
            const selector = `a[href*="/explore/${noteId}"], a[href*="/discovery/item/${noteId}"]`;
            const link = main ? main.querySelector(selector) : document.querySelector(selector);
            const article = link ? link.closest("article") : null;
            if (article) scopeRoot = article;
          }
          if (scopeRoot === document && main) {
            const article = main.querySelector("article");
            if (article) scopeRoot = article;
            else scopeRoot = main;
          }
        }
      } catch (err) {
        // ignore
      }

      const imgs = scopeRoot.querySelectorAll("img");
      for (const img of imgs) {
        try {
          if (location.hostname.endsWith("instagram.com")) {
            const alt = (img.getAttribute("alt") || "").toLowerCase();
            if (alt.includes("profile picture") || alt.includes("头像")) {
              continue;
            }
            if (img.closest("header") || img.closest("nav") || img.closest("aside")) {
              continue;
            }
          }
        } catch (err) {
          // ignore
        }
        const bestFromSrcset = pickLargestFromSrcset(img.getAttribute("srcset"));
        if (bestFromSrcset) {
          const info = normalizeTwitterImage(bestFromSrcset);
          if (info.key && info.key.includes("/media/")) {
            const prev = twitterBestByKey.get(info.key);
            if (!prev || twitterNameRank(info.name) > twitterNameRank(prev.name)) {
              twitterBestByKey.set(info.key, info);
            }
          } else {
            urls.add(bestFromSrcset);
          }
        }
        if (img.currentSrc) {
          const info = normalizeTwitterImage(img.currentSrc);
          if (info.key && info.key.includes("/media/")) {
            const prev = twitterBestByKey.get(info.key);
            if (!prev || twitterNameRank(info.name) > twitterNameRank(prev.name)) {
              twitterBestByKey.set(info.key, info);
            }
          } else {
            urls.add(img.currentSrc);
          }
        }
        if (img.src) {
          const info = normalizeTwitterImage(img.src);
          if (info.key && info.key.includes("/media/")) {
            const prev = twitterBestByKey.get(info.key);
            if (!prev || twitterNameRank(info.name) > twitterNameRank(prev.name)) {
              twitterBestByKey.set(info.key, info);
            }
          } else {
            urls.add(img.src);
          }
        }
      }

      for (const info of twitterBestByKey.values()) {
        const best = ensureLargestTwitterUrl(info);
        urls.add(best.url);
      }

      const filtered = Array.from(urls).filter((u) => {
        if (!u) return false;
        if (u.includes("/profile_images/")) return false;
        if (u.includes("emoji")) return false;
        if (u.includes("hashflags")) return false;
        return true;
      });

      return filtered;
    }
  });
  return result || [];
}

async function getInstagramPostImageUrlsPrecise(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function getShortcode() {
        try {
          const m = location.pathname.match(/\/(reel|p)\/([^/?#]+)/);
          return m ? m[2] : "";
        } catch (err) {
          return "";
        }
      }

      function pickLargestFromSrcset(srcset) {
        if (!srcset) return "";
        const candidates = srcset
          .split(",")
          .map((item) => item.trim())
          .map((item) => {
            const parts = item.split(/\s+/);
            const url = parts[0];
            let size = 0;
            const desc = parts[1] || "";
            const m = desc.match(/(\d+)(w|x)/i);
            if (m) size = parseInt(m[1], 10);
            return { url, size };
          })
          .filter((c) => c.url);
        if (!candidates.length) return "";
        candidates.sort((a, b) => b.size - a.size);
        return candidates[0].url;
      }

      const shortcode = getShortcode();
      if (!shortcode) return [];
      const noteId = shortcode;

      const main = document.querySelector("main");
      const selector = `a[href*="/reel/${shortcode}/"], a[href*="/p/${shortcode}/"]`;
      const link = main ? main.querySelector(selector) : document.querySelector(selector);
      const article = link ? link.closest("article") : (main ? main.querySelector("article") : null);
      let scopeRoot = article || null;

      if (!scopeRoot) {
        const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
        if (dialog) scopeRoot = dialog;
      }

      const urls = new Set();
      if (scopeRoot) {
        const imgs = scopeRoot.querySelectorAll("img");
        for (const img of imgs) {
          try {
            const alt = (img.getAttribute("alt") || "").toLowerCase();
            if (alt.includes("profile picture") || alt.includes("头像")) {
              continue;
            }
            if (img.closest("header") || img.closest("nav") || img.closest("aside")) {
              continue;
            }
          } catch (err) {
            // ignore
          }

          const bestFromSrcset = pickLargestFromSrcset(img.getAttribute("srcset"));
          if (bestFromSrcset) {
            urls.add(bestFromSrcset);
            continue;
          }
          if (img.currentSrc) urls.add(img.currentSrc);
          if (img.src) urls.add(img.src);
        }
      }

      if (!urls.size) {
        const ogImage = document.querySelector('meta[property="og:image"]');
        if (ogImage && ogImage.content) urls.add(ogImage.content);
        const ogImageSecure = document.querySelector('meta[property="og:image:secure_url"]');
        if (ogImageSecure && ogImageSecure.content) urls.add(ogImageSecure.content);
      }

      if (!urls.size && noteId) {
        try {
          const scripts = Array.from(document.querySelectorAll("script"));
          const urlRe = /(https?:\/\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|gif))(?:\?[^"'\\\s]*)?/ig;
          for (const s of scripts) {
            const text = s.textContent || "";
            if (!text || !text.includes(noteId)) continue;
            let m;
            while ((m = urlRe.exec(text)) !== null) {
              const u = m[1];
              if (u.includes("xhscdn.com") || u.includes("xiaohongshu.com")) {
                urls.add(u);
              }
            }
            if (urls.size) break;
          }
        } catch (err) {
          // ignore
        }
      }

      if (!urls.size && noteId) {
        try {
          const globals = [
            window.__INITIAL_STATE__,
            window.__INITIAL_DATA__,
            window.__NUXT__,
            window.__XHS_DATA__
          ].filter(Boolean);

          function findNoteData(root, targetId) {
            const seen = new Set();
            const stack = [root];
            let steps = 0;
            while (stack.length && steps < 5000) {
              steps += 1;
              const cur = stack.pop();
              if (!cur || typeof cur !== "object") continue;
              if (seen.has(cur)) continue;
              seen.add(cur);

              if (cur.noteId === targetId || cur.note_id === targetId || cur.id === targetId) {
                return cur;
              }
              for (const k of Object.keys(cur)) {
                const v = cur[k];
                if (v && typeof v === "object") stack.push(v);
              }
            }
            return null;
          }

          function collectUrlsFromObject(root) {
            const out = new Set();
            const seen = new Set();
            const stack = [root];
            let steps = 0;
            while (stack.length && steps < 5000) {
              steps += 1;
              const cur = stack.pop();
              if (!cur) continue;
              if (typeof cur === "string") {
                if ((cur.includes("xhscdn.com") || cur.includes("xiaohongshu.com")) &&
                    cur.match(/\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i)) {
                  out.add(cur);
                }
                continue;
              }
              if (typeof cur !== "object") continue;
              if (seen.has(cur)) continue;
              seen.add(cur);
              for (const k of Object.keys(cur)) {
                const v = cur[k];
                if (v && typeof v === "object") stack.push(v);
                else if (typeof v === "string") stack.push(v);
              }
            }
            return Array.from(out);
          }

          for (const g of globals) {
            const noteData = findNoteData(g, noteId);
            if (noteData) {
              const found = collectUrlsFromObject(noteData);
              for (const u of found) urls.add(u);
              if (urls.size) break;
            }
          }
        } catch (err) {
          // ignore
        }
      }

      return Array.from(urls);
    }
  });
  return result || [];
}

async function getXhsPostImageUrlsPrecise(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function getNoteId() {
        try {
          const m = location.pathname.match(/\/(explore|discovery\/item)\/([^/?#]+)/);
          return m ? m[2] : "";
        } catch (err) {
          return "";
        }
      }

      function pickLargestFromSrcset(srcset) {
        if (!srcset) return "";
        const candidates = srcset
          .split(",")
          .map((item) => item.trim())
          .map((item) => {
            const parts = item.split(/\s+/);
            const url = parts[0];
            let size = 0;
            const desc = parts[1] || "";
            const m = desc.match(/(\d+)(w|x)/i);
            if (m) size = parseInt(m[1], 10);
            return { url, size };
          })
          .filter((c) => c.url);
        if (!candidates.length) return "";
        candidates.sort((a, b) => b.size - a.size);
        return candidates[0].url;
      }

      const noteId = getNoteId();
      if (!noteId) return [];

      const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
      const main = document.querySelector("main");
      const selector = `a[href*="/explore/${noteId}"], a[href*="/discovery/item/${noteId}"]`;
      const link = main ? main.querySelector(selector) : document.querySelector(selector);
      const article = link ? link.closest("article") : null;
      const scopeRoot = dialog || article;
      if (!scopeRoot) return [];

      const urls = new Set();
      const imgs = scopeRoot.querySelectorAll("img");
      for (const img of imgs) {
        const bestFromSrcset = pickLargestFromSrcset(img.getAttribute("srcset"));
        if (bestFromSrcset) {
          urls.add(bestFromSrcset);
          continue;
        }
        if (img.currentSrc) urls.add(img.currentSrc);
        if (img.src) urls.add(img.src);
        const ds = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-url");
        if (ds) urls.add(ds);
      }

      const bgEls = scopeRoot.querySelectorAll("[style*='background-image']");
      for (const el of bgEls) {
        const style = el.getAttribute("style") || "";
        const m = style.match(/background-image:\s*url\((['"]?)(.*?)\1\)/i);
        if (m && m[2]) urls.add(m[2]);
      }

      if (!urls.size) {
        const ogImage = document.querySelector('meta[property="og:image"]');
        if (ogImage && ogImage.content) urls.add(ogImage.content);
        const ogImageSecure = document.querySelector('meta[property="og:image:secure_url"]');
        if (ogImageSecure && ogImageSecure.content) urls.add(ogImageSecure.content);
      }

      return Array.from(urls);
    }
  });
  return result || [];
}

async function getXhsPostImageUrlsPreciseAllFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      function getNoteId() {
        try {
          const m = location.pathname.match(/\/(explore|discovery\/item)\/([^/?#]+)/);
          return m ? m[2] : "";
        } catch (err) {
          return "";
        }
      }

      function pickLargestFromSrcset(srcset) {
        if (!srcset) return "";
        const candidates = srcset
          .split(",")
          .map((item) => item.trim())
          .map((item) => {
            const parts = item.split(/\s+/);
            const url = parts[0];
            let size = 0;
            const desc = parts[1] || "";
            const m = desc.match(/(\d+)(w|x)/i);
            if (m) size = parseInt(m[1], 10);
            return { url, size };
          })
          .filter((c) => c.url);
        if (!candidates.length) return "";
        candidates.sort((a, b) => b.size - a.size);
        return candidates[0].url;
      }

      const noteId = getNoteId();
      if (!noteId) return [];

      let scopeRoot = null;
      const attrSelectors = [
        `[note_id="${noteId}"]`,
        `[note-id="${noteId}"]`,
        `[data-note-id="${noteId}"]`
      ];
      for (const sel of attrSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          scopeRoot = el;
          break;
        }
      }
      if (!scopeRoot) {
        const selector = `a[href*="/explore/${noteId}"], a[href*="/discovery/item/${noteId}"]`;
        const link = document.querySelector(selector);
        const article = link ? link.closest("article") : null;
        scopeRoot = article || document;
      }

      const urls = new Set();
      const imgs = scopeRoot.querySelectorAll("img");
      for (const img of imgs) {
        const bestFromSrcset = pickLargestFromSrcset(img.getAttribute("srcset"));
        if (bestFromSrcset) {
          urls.add(bestFromSrcset);
          continue;
        }
        if (img.currentSrc) urls.add(img.currentSrc);
        if (img.src) urls.add(img.src);
        const ds = img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-url");
        if (ds) urls.add(ds);
      }

      const bgEls = scopeRoot.querySelectorAll("[style*='background-image']");
      for (const el of bgEls) {
        const style = el.getAttribute("style") || "";
        const m = style.match(/background-image:\s*url\((['"]?)(.*?)\1\)/i);
        if (m && m[2]) urls.add(m[2]);
      }

      return Array.from(urls);
    }
  });

  const all = [];
  for (const r of results || []) {
    if (Array.isArray(r.result)) all.push(...r.result);
  }
  return all;
}

async function getXhsBlobImageDataUrlsPrecise(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      try {
        const dialog = document.querySelector('div[role="dialog"], div[aria-modal="true"]');
        const scopeRoot = dialog || document;
        const imgs = Array.from(scopeRoot.querySelectorAll("img"));
        const blobUrls = imgs
          .map((i) => i.currentSrc || i.src || "")
          .filter((u) => u.startsWith("blob:"));
        const unique = Array.from(new Set(blobUrls));

        const dataUrls = [];
        for (const u of unique) {
          try {
            const resp = await fetch(u);
            const blob = await resp.blob();
            const dataUrl = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
            if (typeof dataUrl === "string") dataUrls.push(dataUrl);
          } catch (err) {
            // ignore
          }
        }
        return dataUrls;
      } catch (err) {
        return [];
      }
    }
  });
  return result || [];
}

downloadBtn.addEventListener("click", async () => {
  setStatus("正在读取当前页面...");
  downloadBtn.disabled = true;

  try {
    const tab = await getActiveTab();
    const url = tab && tab.url ? tab.url : "";
    if (!url) {
      setStatus("未找到当前页面链接。");
      downloadBtn.disabled = false;
      return;
    }

    const host = new URL(url).hostname;
    const timestamp = formatTimestamp(new Date());
    const username = await getUsernameFromPage(tab.id);
    let publishTime = await getPublishTimeFromPage(tab.id);
    if (!publishTime) publishTime = formatDateOnly(new Date());

    if (isInstagramHost(host)) {
      setStatus("不支持该网站的视频下载。");
      downloadBtn.disabled = false;
      return;
    }

    if (isTwitterHost(host)) {
      const tweetId = parseTweetId(url);
      if (!tweetId) {
        setStatus("未识别到推文链接。请在目标页面打开扩展。");
        downloadBtn.disabled = false;
        return;
      }
      setStatus("解析中...");

      chrome.runtime.sendMessage(
        { type: "download_twitter", tweetId, timestamp, username, publishTime },
        (resp) => {
          if (chrome.runtime.lastError) {
            setStatus("发生错误：" + chrome.runtime.lastError.message);
            downloadBtn.disabled = false;
            return;
          }
          if (!resp || !resp.ok) {
            setStatus("失败：" + (resp && resp.error ? resp.error : "未知错误"));
            downloadBtn.disabled = false;
            return;
          }
          setStatus("已开始下载：" + resp.filename);
          downloadBtn.disabled = false;
        }
      );
      return;
    }

    if (isXhsHost(host)) {
      setStatus("解析中...");
      chrome.runtime.sendMessage(
        { type: "download_xhs", pageUrl: url, timestamp, username, publishTime },
        (resp) => {
          if (chrome.runtime.lastError) {
            setStatus("发生错误：" + chrome.runtime.lastError.message);
            downloadBtn.disabled = false;
            return;
          }
          if (!resp || !resp.ok) {
            setStatus("失败：" + (resp && resp.error ? resp.error : "未知错误"));
            downloadBtn.disabled = false;
            return;
          }
          setStatus("已开始下载：" + resp.filename);
          downloadBtn.disabled = false;
        }
      );
      return;
    }

    setStatus("尝试通用解析中...");
    const urls = await getPageVideoUrls(tab.id);
    const mp4 = urls.find((u) => u.includes(".mp4")) || urls[0];
    if (!mp4) {
      setStatus("未检测到可下载的视频。可能原因：\n- 页面没有 <video> 标签\n- 视频为分片格式（如 m3u8）\n- 站点做了权限限制");
      downloadBtn.disabled = false;
      return;
    }

    const safeUser = sanitizePart(username);
    const folder = buildFolderName(safeUser, publishTime);
    const filename = `${folder}/${safeUser}_${timestamp}.mp4`;
    const downloadId = await chrome.downloads.download({ url: mp4, filename, saveAs: false });
    if (!downloadId) {
      setStatus("下载未能启动。请检查下载权限或链接是否可访问。");
      downloadBtn.disabled = false;
      return;
    }
    setStatus("已开始下载：" + filename + "\n若失败请把错误提示发给我。");
    downloadBtn.disabled = false;
  } catch (err) {
    setStatus("发生错误：" + (err && err.message ? err.message : String(err)));
    downloadBtn.disabled = false;
  }
});

downloadImagesBtn.addEventListener("click", async () => {
  setStatus("正在查找图片...");
  downloadImagesBtn.disabled = true;
  showBatchControls(false);
  pendingQueue = null;
  pendingIndex = 0;
  totalDownloaded = 0;
  totalSkipped = 0;
  pendingTotal = 0;
  knownDedupeKeys = [];
  await chrome.storage.local.remove(["batchState"]);

  try {
    const tab = await getActiveTab();
    const url = tab && tab.url ? tab.url : "";
    if (!url) {
      setStatus("未找到当前页面链接。");
      downloadImagesBtn.disabled = false;
      return;
    }
    const host = new URL(url).hostname;
    if (host.endsWith("instagram.com") && !isInstagramPostUrl(url)) {
      setStatus("当前为主页/列表页，将按全量尝试下载（最多20张）...");
    }

    const timestamp = formatTimestamp(new Date());
    const username = await getUsernameFromPage(tab.id);
    let publishTime = await getPublishTimeFromPage(tab.id);
    if (!publishTime) publishTime = formatDateOnly(new Date());

    if (isTwitterHost(host)) {
      const tweetId = parseTweetId(url);
      if (tweetId) {
        chrome.runtime.sendMessage(
          { type: "download_twitter_post_media", tweetId, timestamp, username, publishTime },
          (resp) => {
            if (chrome.runtime.lastError) {
              setStatus("发生错误：" + chrome.runtime.lastError.message);
              downloadImagesBtn.disabled = false;
              return;
            }
            if (!resp || !resp.ok) {
              setStatus("失败：" + (resp && resp.error ? resp.error : "未知错误"));
              downloadImagesBtn.disabled = false;
              return;
            }
            setStatus(
              `已开始下载图片：${resp.downloadedImages || 0} 张（跳过 ${resp.skippedImages || 0}）\n` +
              `已开始下载视频：${resp.downloadedVideos || 0} 条（跳过 ${resp.skippedVideos || 0}）`
            );
            downloadImagesBtn.disabled = false;
          }
        );
        return;
      }
    }

    let urls = [];
    if (isTwitterMediaPageUrl(url)) {
      setStatus("正在自动滚动收集图片，请稍候...");
      urls = await getTwitterMediaImageUrlsByAutoScroll(tab.id);
    } else {
      urls = await getPageImageUrls(tab.id);
    }
    const filtered = urls.filter((u) => {
      if (!u) return false;
      if (u.startsWith("data:")) return false;
      if (host.endsWith("xiaohongshu.com")) {
        return isLikelyXhsImageUrl(u);
      }
      return /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(u) || u.startsWith("http");
    });

    const unique = Array.from(new Set(filtered));
    if (!unique.length) {
      setStatus("未检测到可下载的图片。");
      downloadImagesBtn.disabled = false;
      return;
    }

    pendingQueue = unique;
    pendingIndex = 0;
    pendingMeta = { timestamp, username, publishTime };
    pendingTotal = pendingQueue.length;
    knownDedupeKeys = [];
    setStatus(`共检测到 ${pendingQueue.length} 张图片，准备按每批 ${BATCH_SIZE} 张下载。`);
    downloadImagesBtn.disabled = false;
    await queueSaveBatchState();
    await startNextBatch();
  } catch (err) {
    setStatus("发生错误：" + (err && err.message ? err.message : String(err)));
    downloadImagesBtn.disabled = false;
  }
});

async function startNextBatch() {
  if (isBatchDownloading) return;
  if (!pendingQueue || !pendingQueue.length) {
    showBatchControls(false);
    return;
  }
  const start = pendingIndex;
  const end = Math.min(start + BATCH_SIZE, pendingQueue.length);
  const batch = pendingQueue.slice(start, end);
  if (!batch.length) {
    showBatchControls(false);
    setStatus("没有可继续下载的图片。");
    return;
  }

  showBatchControls(false);
  isBatchDownloading = true;
  continueBatchBtn.disabled = true;
  stopBatchBtn.disabled = true;
  setStatus(`正在下载第 ${start + 1}-${end} 张...`);

  // Persist next cursor before sending the batch.
  // If popup closes mid-download, we still resume from the next range.
  pendingIndex = end;
  await queueSaveBatchState();

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "download_images", urls: batch, startIndex: start, knownDedupeKeys, ...pendingMeta },
      (resp) => {
        if (chrome.runtime.lastError) {
          pendingIndex = start;
          queueSaveBatchState();
          setStatus("发生错误：" + chrome.runtime.lastError.message);
          showBatchControls(false);
          isBatchDownloading = false;
          stopBatchBtn.disabled = false;
          resolve();
          return;
        }
        if (!resp || !resp.ok) {
          pendingIndex = start;
          queueSaveBatchState();
          setStatus("失败：" + (resp && resp.error ? resp.error : "未知错误"));
          showBatchControls(false);
          isBatchDownloading = false;
          stopBatchBtn.disabled = false;
          resolve();
          return;
        }
        totalDownloaded += resp.downloaded || 0;
        totalSkipped += resp.skipped || 0;
        knownDedupeKeys = Array.isArray(resp.knownDedupeKeys) ? resp.knownDedupeKeys : knownDedupeKeys;
        queueSaveBatchState();
        isBatchDownloading = false;

        if (pendingIndex < pendingQueue.length) {
          setStatus(
            `已下载：${totalDownloaded} 张，已跳过：${totalSkipped} 张\n` +
            `是否继续下载下一批？`
          );
          showBatchControls(true);
          continueBatchBtn.disabled = false;
          stopBatchBtn.disabled = false;
        } else {
          setStatus(
            `下载完成：${totalDownloaded} 张，跳过：${totalSkipped} 张`
          );
          showBatchControls(false);
          pendingQueue = null;
          pendingIndex = 0;
          pendingMeta = null;
          pendingTotal = 0;
          knownDedupeKeys = [];
          continueBatchBtn.disabled = false;
          stopBatchBtn.disabled = false;
          chrome.storage.local.remove(["batchState"]);
        }
        resolve();
      }
    );
  });
}

continueBatchBtn.addEventListener("click", async () => {
  await startNextBatch();
});

stopBatchBtn.addEventListener("click", () => {
  pendingQueue = null;
  pendingIndex = 0;
  pendingMeta = null;
  pendingTotal = 0;
  knownDedupeKeys = [];
  isBatchDownloading = false;
  continueBatchBtn.disabled = false;
  stopBatchBtn.disabled = false;
  showBatchControls(false);
  setStatus("已停止继续下载。");
  chrome.storage.local.remove(["batchState"]);
});

restoreBatchState();

downloadImagesPreciseBtn.addEventListener("click", async () => {
  setStatus("正在查找图片(精确)...");
  downloadImagesPreciseBtn.disabled = true;

  try {
    const tab = await getActiveTab();
    const url = tab && tab.url ? tab.url : "";
    if (!url) {
      setStatus("未找到当前页面链接。");
      downloadImagesPreciseBtn.disabled = false;
      return;
    }
    const host = new URL(url).hostname;
    if (host.endsWith("instagram.com") && !isInstagramPostUrl(url)) {
      setStatus("请先进入具体帖子页面（/p/ 或 /reel/）再下载图片。");
      downloadImagesPreciseBtn.disabled = false;
      return;
    }
    if (host.endsWith("xiaohongshu.com") && !isXhsPostUrl(url)) {
      setStatus("请先进入具体帖子页面（/explore/ 或 /discovery/item/）再下载图片。");
      downloadImagesPreciseBtn.disabled = false;
      return;
    }

    const timestamp = formatTimestamp(new Date());
    const username = await getUsernameFromPage(tab.id);
    let publishTime = await getPublishTimeFromPage(tab.id);
    if (!publishTime) publishTime = formatDateOnly(new Date());

    if (isTwitterHost(host)) {
      const tweetId = parseTweetId(url);
      if (!tweetId) {
        setStatus("请先进入具体帖子页面（/status/...）再精确下载。");
        downloadImagesPreciseBtn.disabled = false;
        return;
      }
      const urls = await getTwitterPostImageUrlsPrecise(tab.id);
      const filtered = urls.filter((u) => u && !u.startsWith("data:") && u.startsWith("http"));
      const unique = Array.from(new Set(filtered));
      if (!unique.length) {
        setStatus("未检测到该帖可下载的图片。");
        downloadImagesPreciseBtn.disabled = false;
        return;
      }
      chrome.runtime.sendMessage(
        { type: "download_images", urls: unique, timestamp, username, publishTime },
        (resp) => {
          if (chrome.runtime.lastError) {
            setStatus("发生错误：" + chrome.runtime.lastError.message);
            downloadImagesPreciseBtn.disabled = false;
            return;
          }
          if (!resp || !resp.ok) {
            setStatus("失败：" + (resp && resp.error ? resp.error : "未知错误"));
            downloadImagesPreciseBtn.disabled = false;
            return;
          }
          setStatus(
            `已开始下载图片：${resp.downloaded} 张\n` +
            `已跳过：${resp.skipped} 张`
          );
          downloadImagesPreciseBtn.disabled = false;
        }
      );
      return;
    }

    if (host.endsWith("xiaohongshu.com")) {
      chrome.runtime.sendMessage(
        { type: "download_xhs", pageUrl: url, timestamp, username, publishTime },
        () => {}
      );
    }
    let urls = [];
    if (host.endsWith("instagram.com")) {
      urls = await getInstagramPostImageUrlsPrecise(tab.id);
    } else if (host.endsWith("xiaohongshu.com")) {
      urls = await getXhsPostImageUrlsPrecise(tab.id);
      if (!urls.length) {
        urls = await getXhsPostImageUrlsPreciseAllFrames(tab.id);
      }
    } else {
      urls = await getPageImageUrls(tab.id);
    }
    const filtered = urls.filter((u) => {
      if (!u) return false;
      if (u.startsWith("data:")) return false;
      if (host.endsWith("xiaohongshu.com")) {
        return isLikelyXhsImageUrl(u);
      }
      return /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(u) || u.startsWith("http");
    });

    let unique = Array.from(new Set(filtered));
    if (!unique.length && host.endsWith("xiaohongshu.com")) {
      const dataUrls = await getXhsBlobImageDataUrlsPrecise(tab.id);
      if (dataUrls && dataUrls.length) {
        const safeUser = sanitizePart(username);
        const folder = buildFolderName(safeUser, publishTime);
        let idx = 0;
        for (const durl of dataUrls) {
          idx += 1;
          const ext = durl.startsWith("data:image/png") ? "png" :
            durl.startsWith("data:image/webp") ? "webp" :
            durl.startsWith("data:image/gif") ? "gif" : "jpg";
          const filename = `${folder}/${safeUser}_${timestamp}_${String(idx).padStart(3, "0")}.${ext}`;
          try {
            await chrome.downloads.download({ url: durl, filename, saveAs: false });
          } catch (err) {
            // ignore
          }
        }
        setStatus(`已开始下载图片：${dataUrls.length} 张`);
        downloadImagesPreciseBtn.disabled = false;
        return;
      }
    }

    if (!unique.length) {
      if (host.endsWith("xiaohongshu.com")) {
        setStatus("未检测到可下载的图片，已尝试下载视频。");
      } else {
        setStatus("未检测到可下载的图片。");
      }
      downloadImagesPreciseBtn.disabled = false;
      return;
    }

    chrome.runtime.sendMessage(
      { type: "download_images", urls: unique, timestamp, username, publishTime },
      (resp) => {
        if (chrome.runtime.lastError) {
          setStatus("发生错误：" + chrome.runtime.lastError.message);
          downloadImagesPreciseBtn.disabled = false;
          return;
        }
        if (!resp || !resp.ok) {
          setStatus("失败：" + (resp && resp.error ? resp.error : "未知错误"));
          downloadImagesPreciseBtn.disabled = false;
          return;
        }
        setStatus(
          `已开始下载图片：${resp.downloaded} 张\n` +
          `已跳过：${resp.skipped} 张`
        );
        downloadImagesPreciseBtn.disabled = false;
      }
    );
  } catch (err) {
    setStatus("发生错误：" + (err && err.message ? err.message : String(err)));
    downloadImagesPreciseBtn.disabled = false;
  }
});
