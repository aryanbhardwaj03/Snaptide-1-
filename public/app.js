const form = document.querySelector("#lookupForm");
const urlInput = document.querySelector("#videoUrl");
const analyzeBtn = document.querySelector("#analyzeBtn");
const result = document.querySelector("#result");
const preview = document.querySelector(".preview");
const thumbnail = document.querySelector("#thumbnail");
const sourceName = document.querySelector("#sourceName");
const title = document.querySelector("#title");
const details = document.querySelector("#details");
const qualityHint = document.querySelector("#qualityHint");
const qualityList = document.querySelector("#qualityList");
const audioOnly = document.querySelector("#audioOnly");
const downloadBtn = document.querySelector("#downloadBtn");
const downloadState = document.querySelector("#downloadState");
const downloadPercent = document.querySelector("#downloadPercent");
const progressFill = document.querySelector("#progressFill");
const downloadFileName = document.querySelector("#downloadFileName");
const downloadFileSize = document.querySelector("#downloadFileSize");
const themeToggle = document.querySelector("#themeToggle");

let currentUrl = "";
let currentQualityLabel = "1080p";
let autoFetchTimer = null;
let lastPreparedUrl = "";
let activeDownloadPoll = null;
let previewToken = 0;
let currentTheme = "dark";

function writeLog(message, link) {
  console.info(message, link || "");
}

function applyTheme(theme) {
  currentTheme = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
  if (themeToggle) {
    const isDark = currentTheme === "dark";
    themeToggle.textContent = isDark ? "Light theme" : "Dark theme";
    themeToggle.setAttribute("aria-pressed", String(!isDark));
  }
}

function initThemeToggle() {
  if (!themeToggle) return;
  const saved = localStorage.getItem("theme");
  applyTheme(saved || "dark");
  themeToggle.addEventListener("click", () => {
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", nextTheme);
    applyTheme(nextTheme);
  });
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function displayPercent(value) {
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  if (safeValue > 0 && safeValue < 1) return 1;
  return Math.floor(safeValue);
}

function renderProgress(value) {
  const percentText = displayPercent(value);
  downloadPercent.textContent = `${percentText}%`;
  progressFill.style.width = `${value}%`;
}

function setDownloadProgress({ state = "Ready", progress = 0, fileName = "Waiting for download", fileSize = "" } = {}) {
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  downloadState.textContent = state;
  downloadFileName.textContent = fileName || "Waiting for download";
  downloadFileSize.textContent = fileSize ? formatBytes(fileSize) : "--";
  renderProgress(safeProgress);
}

function autoStartBrowserDownload(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const detail = data.installHint ? ` ${data.installHint}` : "";
    throw new Error(`${data.error || "Request failed."}${detail}`);
  }
  return data;
}

function selectedQuality() {
  return document.querySelector('input[name="quality"]:checked')?.value || "1080";
}

function isUsableUrl(value) {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname.includes(".");
  } catch {
    return false;
  }
}

function updateDownloadText() {
  const selected = document.querySelector('input[name="quality"]:checked');
  currentQualityLabel = selected?.dataset.label || "1080p";
  downloadBtn.textContent = audioOnly.checked ? "Download MP3" : `Download ${currentQualityLabel}`;
}

function buildQualityList(options, maxHeight) {
  qualityList.innerHTML = "";
  const qualities = options?.length
    ? options
    : [
        {
          value: "1080",
          label: "Best up to 1080p",
          description: "Default for smooth downloads and broad device support.",
          default: true,
          available: true
        }
      ];

  qualities.forEach((quality, index) => {
    const item = document.createElement("label");
    item.className = "quality-option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "quality";
    input.value = quality.value;
    input.dataset.label = quality.value === "source" ? "maximum quality" : `${quality.height || quality.value}p`;
    input.checked = Boolean(quality.default) || index === 0;
    input.disabled = quality.available === false;
    input.addEventListener("change", updateDownloadText);

    const text = document.createElement("span");
    text.className = "quality-text";

    const titleRow = document.createElement("span");
    titleRow.className = "quality-title";
    titleRow.textContent = quality.label;

    const description = document.createElement("span");
    description.className = "quality-description";
    description.textContent = quality.description || "";

    text.append(titleRow, description);
    item.append(input, text);
    qualityList.append(item);
  });

  if (maxHeight && maxHeight > 1080) {
    qualityHint.textContent = `${maxHeight}p is available. 1080p stays selected unless you choose higher.`;
  } else {
    qualityHint.textContent = "Best available up to 1080p is selected automatically.";
  }

  downloadBtn.disabled = false;
  updateDownloadText();
}

function prepareInstantDownload(url) {
  if (!isUsableUrl(url)) return;
  currentUrl = url;

  if (lastPreparedUrl !== url) {
    buildQualityList(null, null);
    result.classList.remove("is-hidden");
    if (preview) preview.classList.add("loading");
    thumbnail.src = "";
    thumbnail.classList.add("is-empty");
    sourceName.textContent = "";
    title.textContent = "";
    details.textContent = "";
    qualityHint.textContent = "Ready instantly at 1080p. Higher options load in the background.";
    setDownloadProgress({
      state: "Ready for 1080p",
      progress: 0,
      fileName: "Press Download to start",
      fileSize: ""
    });
    lastPreparedUrl = url;
  }

  downloadBtn.disabled = false;
  analyzeBtn.textContent = "Refresh";
  updateDownloadText();
}

function applyVideoInfo(data) {
  const isPlaceholder = !data.title && !data.thumbnail;
  thumbnail.src = data.thumbnail || "";
  if (data.thumbnail) {
    thumbnail.classList.remove("is-empty");
  } else {
    thumbnail.classList.add("is-empty");
  }
  sourceName.textContent = data.extractor || (data.thumbnail ? "Supported platform" : "");
  title.textContent = data.title || "";
  const durationText = formatDuration(data.duration);
  if (data.uploader && durationText) {
    details.textContent = `${data.uploader} · ${durationText}`;
  } else if (data.uploader) {
    details.textContent = data.uploader;
  } else {
    details.textContent = durationText;
  }
  buildQualityList(data.qualityOptions, data.maxHeight);
  result.classList.remove("is-hidden");
  if (preview && data.thumbnail) preview.classList.remove("loading");
}

function renderVideoInfo(data) {
  previewToken += 1;
  const token = previewToken;

  if (!data.thumbnail && data.qualityPending) {
    setDownloadProgress({
      state: "Fetching thumbnail",
      progress: 0,
      fileName: "Preview loading",
      fileSize: ""
    });
    applyVideoInfo(data);
    if (preview) preview.classList.add("loading");
    return;
  }

  if (!data.thumbnail) {
    applyVideoInfo(data);
    return;
  }

  const previewImage = new Image();
  previewImage.onload = () => {
    if (token === previewToken) applyVideoInfo(data);
  };
  previewImage.onerror = () => {
    if (token === previewToken) applyVideoInfo({ ...data, thumbnail: "" });
  };
  previewImage.src = data.thumbnail;
}

async function loadFullQualities(url) {
  writeLog("Checking higher quality options in the background...");
  try {
    const data = await requestJson("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (url !== currentUrl) return;
    renderVideoInfo(data);
    writeLog(data.cached ? "Quality options loaded from cache." : "Higher quality options loaded.");
  } catch (error) {
    writeLog(`Could not load higher quality options: ${error.message}`);
  }
}

async function fetchVideoInfo(url, quick = true, silent = false) {
  if (!isUsableUrl(url)) {
    setDownloadProgress({ state: "Paste a valid video URL", progress: 0, fileName: "No file selected" });
    if (!silent) writeLog("Paste a valid video URL first.");
    return;
  }

  prepareInstantDownload(url);
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Fetching";
  if (!silent) writeLog("Fetching video info...");

  try {
    const data = await requestJson("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quick })
    });

    if (url !== currentUrl) return;
    renderVideoInfo(data);
    if (!silent) {
      writeLog(data.cached ? "Video info loaded from cache." : "Video info loaded. 1080p is ready.");
    }
    if (data.qualityPending) {
      loadFullQualities(url);
    }
  } catch (error) {
    if (!silent) {
      setDownloadProgress({ state: error.message, progress: 0, fileName: "Video info unavailable" });
      writeLog(error.message);
    }
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Refresh";
  }
}

function scheduleInstantFetch() {
  const url = urlInput.value.trim();
  clearTimeout(autoFetchTimer);

  if (!isUsableUrl(url)) {
    if (!currentUrl) downloadBtn.disabled = true;
    analyzeBtn.textContent = "Analyze";
    return;
  }

  prepareInstantDownload(url);
  autoFetchTimer = setTimeout(() => fetchVideoInfo(url, true, true), 160);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await fetchVideoInfo(urlInput.value.trim(), true, false);
});

function stopDownloadPoll() {
  if (activeDownloadPoll) {
    clearInterval(activeDownloadPoll);
    activeDownloadPoll = null;
  }
}

async function pollDownload(jobId) {
  stopDownloadPoll();
  let finished = false;

  const check = async () => {
    try {
      const job = await requestJson(`/api/download-status?id=${encodeURIComponent(jobId)}`);
      if (job.status === "done") {
        finished = true;
        stopDownloadPoll();
        downloadBtn.disabled = false;
        updateDownloadText();
        setDownloadProgress({
          state: "Saved to browser downloads",
          progress: 100,
          fileName: job.fileName,
          fileSize: job.fileSize
        });
        autoStartBrowserDownload(job.downloadUrl, job.fileName);
        writeLog(`Download ready: ${job.fileName}`, job.downloadUrl);
        return;
      }

      if (job.status === "error") {
        finished = true;
        stopDownloadPoll();
        downloadBtn.disabled = false;
        updateDownloadText();
        setDownloadProgress({
          state: job.message || job.error || "Download failed",
          progress: Number(job.progress || 0),
          fileName: "No file saved",
          fileSize: ""
        });
        writeLog(`${job.error || "Download failed."} ${job.message || ""}`.trim());
        return;
      }

      const progress = Number(job.progress || 0);
      setDownloadProgress({
        state: job.message || "Downloading",
        progress,
        fileName: job.fileName || "Preparing file",
        fileSize: job.fileSize
      });
      downloadBtn.textContent = progress > 0 ? `Downloading ${displayPercent(progress)}%` : "Downloading";
    } catch (error) {
      finished = true;
      stopDownloadPoll();
      downloadBtn.disabled = false;
      updateDownloadText();
      setDownloadProgress({ state: "Could not check progress", progress: 0, fileName: "No file saved" });
      writeLog(error.message);
    }
  };

  await check();
  if (!finished) {
    activeDownloadPoll = setInterval(check, 250);
  }
}

downloadBtn.addEventListener("click", async () => {
  const url = currentUrl || urlInput.value.trim();
  if (!isUsableUrl(url)) {
    setDownloadProgress({ state: "Paste a valid video URL", progress: 0, fileName: "No file selected" });
    writeLog("Paste a valid video URL first.");
    return;
  }

  prepareInstantDownload(url);
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Starting";
  setDownloadProgress({
    state: "Starting download",
    progress: 0,
    fileName: "Creating file",
    fileSize: ""
  });
  writeLog("Download job started...");

  try {
    const data = await requestJson("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        quality: selectedQuality(),
        audioOnly: audioOnly.checked
      })
    });

    if (data.jobId) {
      await pollDownload(data.jobId);
    } else {
      autoStartBrowserDownload(data.downloadUrl, data.fileName);
      setDownloadProgress({
        state: "Saved to browser downloads",
        progress: 100,
        fileName: data.fileName,
        fileSize: data.fileSize
      });
      writeLog(`Download ready: ${data.fileName}`, data.downloadUrl);
      downloadBtn.disabled = false;
      updateDownloadText();
    }
  } catch (error) {
    writeLog(error.message);
    setDownloadProgress({ state: "Download failed", progress: 0, fileName: "No file saved" });
    downloadBtn.disabled = false;
    updateDownloadText();
  }
});

audioOnly.addEventListener("change", updateDownloadText);
urlInput.addEventListener("input", scheduleInstantFetch);
urlInput.addEventListener("paste", () => setTimeout(scheduleInstantFetch, 0));

setDownloadProgress();
initThemeToggle();
