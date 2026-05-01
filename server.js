const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const INFO_CACHE_TTL_MS = 15 * 60 * 1000;
const COOKIES_PATH = (process.env.AVD_COOKIES_PATH || "").trim();
const NAME_WORDS = {
  adjectives: [
    "extravagant",
    "snorrlax",
    "bold",
    "silent",
    "vivid",
    "cosmic",
    "glowing",
    "swift",
    "electric",
    "mystic",
    "brisk",
    "golden",
    "cool",
    "loyal",
    "amber",
    "shadow",
    "lunar",
    "crisp",
    "ultra",
    "prime"
  ],
  nouns: [
    "hulk",
    "panther",
    "voyager",
    "spark",
    "comet",
    "atlas",
    "echo",
    "rook",
    "falcon",
    "ember",
    "signal",
    "orbit",
    "neon",
    "vertex",
    "legend",
    "ranger",
    "storm",
    "zen",
    "nova",
    "drift"
  ]
};

const supportedHosts = [
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "linkedin.com",
  "lnkd.in",
  "bsky.app",
  "dailymotion.com",
  "reddit.com"
];

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const executableCache = new Map();
const infoCache = new Map();
const downloadJobs = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/downloads",
  express.static(DOWNLOAD_DIR, {
    setHeaders: (res, filePath) => {
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath).replace(/"/g, "")}"`);
    }
  })
);

function parseVideoUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSupportedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return supportedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function executableCandidates(name) {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    name,
    path.join(localAppData, "Microsoft", "WinGet", "Links", `${name}.exe`),
    path.join(programFiles, name, `${name}.exe`),
    path.join(programFilesX86, name, `${name}.exe`)
  ];

  if (name === "ffmpeg") {
    candidates.push(
      path.join(programFiles, "Gyan", "ffmpeg", "bin", "ffmpeg.exe"),
      path.join(programFiles, "FFmpeg", "bin", "ffmpeg.exe"),
      "C:\\ffmpeg\\bin\\ffmpeg.exe"
    );
  }

  return candidates;
}

function resolveExecutable(name) {
  if (executableCache.has(name)) return executableCache.get(name);

  const absolute = executableCandidates(name).find((candidate) => candidate !== name && fs.existsSync(candidate));
  if (absolute) {
    executableCache.set(name, absolute);
    return absolute;
  }

  const wingetPackages = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  const found = findInDirectory(wingetPackages, `${name}.exe`, name);
  if (found) {
    executableCache.set(name, found);
    return found;
  }
  return name;
}

function findInDirectory(baseDir, fileName, packageName) {
  if (!baseDir || !fs.existsSync(baseDir)) return null;
  const stack = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes(packageName.toLowerCase()))
    .map((entry) => path.join(baseDir, entry.name));

  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return null;
}

function ffmpegLocationArgs() {
  const ffmpeg = resolveExecutable("ffmpeg");
  if (ffmpeg === "ffmpeg") return [];
  return ["--ffmpeg-location", path.dirname(ffmpeg)];
}

function cookieArgs() {
  if (!COOKIES_PATH) return [];
  if (!fs.existsSync(COOKIES_PATH)) return [];
  return ["--cookies", COOKIES_PATH];
}

function randomVideoName() {
  const adjective = NAME_WORDS.adjectives[Math.floor(Math.random() * NAME_WORDS.adjectives.length)];
  const noun = NAME_WORDS.nouns[Math.floor(Math.random() * NAME_WORDS.nouns.length)];
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${adjective}-${noun}-${suffix}`;
}

function hasYtDlp() {
  return new Promise((resolve) => {
    const child = spawn(resolveExecutable("yt-dlp"), ["--version"]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function hasFfmpeg() {
  return new Promise((resolve) => {
    const child = spawn(resolveExecutable("ffmpeg"), ["-version"]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function qualityToFormat(value) {
  const selected = String(value || "1080").trim().toLowerCase();
  if (selected === "source") return "bestvideo+bestaudio/best";
  const height = /^\d{3,4}$/.test(selected)
    ? Math.max(144, Math.min(Number(selected), 8640))
    : 1080;
  return `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

function defaultQualityOptions() {
  return [
    {
      value: "1080",
      label: "Best up to 1080p",
      description: "Default for smooth downloads and broad device support.",
      height: 1080,
      default: true,
      available: true
    }
  ];
}

function buildQualityOptions(formats) {
  const heights = [...new Set(
    formats
      .filter((format) => format.height && format.vcodec !== "none")
      .map((format) => Number(format.height))
  )].sort((a, b) => a - b);
  const maxHeight = heights.length ? heights[heights.length - 1] : null;
  const options = defaultQualityOptions();
  options[0].available = heights.some((height) => height <= 1080) || heights.length === 0;

  heights
    .filter((height) => height > 1080)
    .forEach((height) => {
      options.push({
        value: String(height),
        label: `Up to ${height}p`,
        description: "Higher quality available for this video.",
        height,
        default: false,
        available: true
      });
    });

  if (maxHeight && maxHeight > 1080) {
    options.push({
      value: "source",
      label: "Original maximum",
      description: "Use the highest format the source exposes.",
      height: maxHeight,
      default: false,
      available: true
    });
  }

  return { options, maxHeight };
}

function thumbnailFromInfo(data) {
  if (data.thumbnail) return data.thumbnail;
  const thumbnails = data.thumbnails || [];
  return thumbnails.length ? thumbnails[thumbnails.length - 1].url : null;
}

function buildFullInfoPayload(data) {
  const quality = buildQualityOptions(data.formats || []);
  return {
    title: data.title,
    duration: data.duration,
    thumbnail: thumbnailFromInfo(data),
    uploader: data.uploader || data.channel,
    webpage_url: data.webpage_url,
    extractor: data.extractor_key,
    maxHeight: quality.maxHeight,
    qualityOptions: quality.options,
    qualityPending: false,
    formats: (data.formats || [])
      .filter((format) => format.vcodec !== "none" || format.acodec !== "none")
      .slice(-30)
      .map((format) => ({
        format_id: format.format_id,
        ext: format.ext,
        resolution: format.resolution || `${format.width || "?"}x${format.height || "?"}`,
        fps: format.fps,
        filesize: format.filesize || format.filesize_approx,
        note: format.format_note
      }))
  };
}

function buildQuickInfoPayload(data) {
  return {
    title: data.title || data.fulltitle || "Video ready",
    duration: data.duration,
    thumbnail: thumbnailFromInfo(data),
    uploader: data.uploader || data.channel || "Unknown creator",
    webpage_url: data.webpage_url || data.url,
    extractor: data.extractor_key || data.extractor,
    maxHeight: null,
    qualityOptions: defaultQualityOptions(),
    qualityPending: true,
    formats: []
  };
}

function payloadFromQuickInfo(data) {
  if ((data.formats || []).length && thumbnailFromInfo(data)) return buildFullInfoPayload(data);
  return buildQuickInfoPayload(data);
}

function cacheGet(key) {
  const cached = infoCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.created > INFO_CACHE_TTL_MS) {
    infoCache.delete(key);
    return null;
  }
  return { ...cached.payload, cached: true };
}

function cacheSet(key, payload) {
  infoCache.set(key, { created: Date.now(), payload: { ...payload } });
}

function parseYtDlpJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    const lines = output.split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  }
}

function runYtDlp(args, onLine, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable("yt-dlp"), [...ffmpegLocationArgs(), ...cookieArgs(), ...args]);
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill();
          reject(new Error("yt-dlp timed out while fetching this video."));
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach(onLine);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function runDownloadJob(jobId, args) {
  const job = downloadJobs.get(jobId);
  const child = spawn(resolveExecutable("yt-dlp"), [...ffmpegLocationArgs(), ...cookieArgs(), ...args]);
  let savedPath = "";

  job.status = "running";
  job.message = "Connecting to source...";

  const numberOrNull = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const setProgress = (value, message) => {
    job.progress = Math.max(Number(job.progress || 0), Math.min(99, value));
    job.message = message;
  };

  const handleLine = (line) => {
    const cleanLine = line.trim();
    if (!cleanLine) return;

    if (cleanLine.startsWith("__AVD_PROGRESS__:")) {
      const [, downloadedValue, totalValue, estimateValue] = cleanLine.split(":");
      const downloaded = numberOrNull(downloadedValue);
      const total = numberOrNull(totalValue) || numberOrNull(estimateValue);
      if (downloaded !== null && total) {
        setProgress((downloaded / total) * 100, "Downloading...");
        job.downloadedBytes = Math.round(downloaded);
        job.totalBytes = Math.round(total);
      }
      return;
    }

    const progress = cleanLine.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (progress) {
      setProgress(Number(progress[1]), "Downloading...");
      return;
    }

    if (cleanLine.toLowerCase().startsWith(DOWNLOAD_DIR.toLowerCase()) && fs.existsSync(cleanLine)) {
      savedPath = cleanLine;
      job.progress = Math.max(Number(job.progress || 0), 99);
      job.message = "Finalizing file...";
    } else if (cleanLine.startsWith("[Merger]")) {
      job.progress = Math.max(Number(job.progress || 0), 98);
      job.message = "Merging video and audio...";
    } else if (cleanLine.startsWith("[ExtractAudio]")) {
      job.progress = Math.max(Number(job.progress || 0), 98);
      job.message = "Converting audio...";
    } else if (cleanLine.startsWith("[download] Destination")) {
      job.message = "Downloading...";
    }
  };

  child.stdout.on("data", (chunk) => {
    String(chunk).split(/\r?\n/).forEach(handleLine);
  });

  child.stderr.on("data", (chunk) => {
    String(chunk).split(/\r?\n/).forEach(handleLine);
  });

  child.on("error", (error) => {
    job.status = "error";
    job.error = "Download failed. This app cannot access private, restricted, DRM-protected, or unsupported videos.";
    job.message = error.message;
  });

  child.on("close", (code) => {
    if (code !== 0) {
      job.status = "error";
      job.error = "Download failed. This app cannot access private, restricted, DRM-protected, or unsupported videos.";
      job.message = `yt-dlp exited with ${code}`;
      return;
    }

    if (!savedPath) {
      const baseName = job.baseName || jobId;
      savedPath = fs
        .readdirSync(DOWNLOAD_DIR)
        .map((file) => path.join(DOWNLOAD_DIR, file))
        .find((file) => path.basename(file).startsWith(baseName));
    }

    if (!savedPath || !fs.existsSync(savedPath)) {
      job.status = "error";
      job.error = "Download failed.";
      job.message = "Download finished, but the output file could not be found.";
      return;
    }

    const fileName = path.basename(savedPath);
    job.status = "done";
    job.progress = 100;
    job.message = "Download ready.";
    job.fileName = fileName;
    job.fileSize = fs.statSync(savedPath).size;
    job.downloadUrl = `/downloads/${encodeURIComponent(fileName)}`;
  });
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    ytDlpInstalled: await hasYtDlp(),
    ffmpegInstalled: await hasFfmpeg(),
    supportedHosts
  });
});

app.get("/api/download-status", (req, res) => {
  const job = downloadJobs.get(String(req.query.id || ""));
  if (!job) return res.status(404).json({ error: "Download job was not found." });
  res.json(job);
});

app.post("/api/info", async (req, res) => {
  const videoUrl = parseVideoUrl(req.body.url || "");
  const quick = Boolean(req.body.quick);
  if (!videoUrl || !isSupportedHost(videoUrl.hostname)) {
    return res.status(400).json({ error: "Paste a valid URL from a supported video platform." });
  }

  if (!(await hasYtDlp())) {
    return res.status(503).json({
      error: "yt-dlp is not installed or is not available in PATH.",
      installHint: "Install it with: winget install yt-dlp.yt-dlp"
    });
  }

  const fullKey = `full:${videoUrl.href}`;
  const fullCached = cacheGet(fullKey);
  if (fullCached) return res.json(fullCached);

  if (quick) {
    const quickKey = `quick:${videoUrl.href}`;
    const quickCached = cacheGet(quickKey);
    if (quickCached) return res.json(quickCached);

    const quickLines = [];
    try {
      await runYtDlp(
        [
          "--dump-json",
          "--no-playlist",
          "--no-warnings",
          "--skip-download",
          "--no-check-formats",
          "--socket-timeout",
          "8",
          "--retries",
          "1",
          "--extractor-retries",
          "1",
          videoUrl.href
        ],
        (line) => quickLines.push(line),
        { timeoutMs: 12000 }
      );
      const payload = payloadFromQuickInfo(parseYtDlpJson(quickLines.join("")));
      cacheSet(quickKey, payload);
      if (!payload.qualityPending) cacheSet(fullKey, payload);
      return res.json(payload);
    } catch {
      const payload = buildQuickInfoPayload({ title: "Video ready", url: videoUrl.href });
      cacheSet(quickKey, payload);
      return res.json(payload);
    }
  }

  const lines = [];
  try {
    await runYtDlp(
      [
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--no-check-formats",
        "--socket-timeout",
        "12",
        "--retries",
        "2",
        "--extractor-retries",
        "2",
        videoUrl.href
      ],
      (line) => lines.push(line),
      { timeoutMs: 35000 }
    );
    const payload = buildFullInfoPayload(parseYtDlpJson(lines.join("")));
    cacheSet(fullKey, payload);
    res.json(payload);
  } catch (error) {
    res.status(422).json({
      error: "Could not read this video. Make sure it is public or that you have direct permission to access it.",
      detail: error.message
    });
  }
});

app.post("/api/download", async (req, res) => {
  const videoUrl = parseVideoUrl(req.body.url || "");
  const format = qualityToFormat(req.body.quality || "1080");
  const audioOnly = Boolean(req.body.audioOnly);

  if (!videoUrl || !isSupportedHost(videoUrl.hostname)) {
    return res.status(400).json({ error: "Paste a valid URL from a supported video platform." });
  }

  if (!(await hasYtDlp())) {
    return res.status(503).json({
      error: "yt-dlp is not installed or is not available in PATH.",
      installHint: "Install it with: winget install yt-dlp.yt-dlp"
    });
  }

  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseName = randomVideoName();
  const outputTemplate = path.join(DOWNLOAD_DIR, `${baseName}.%(ext)s`);
  const lines = [];
  const args = [
    "--no-playlist",
    "--restrict-filenames",
    "--continue",
    "--newline",
    "--progress-template",
    "download:__AVD_PROGRESS__:%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--concurrent-fragments",
    "8",
    "--merge-output-format",
    "mp4",
    "--socket-timeout",
    "20",
    "--no-mtime",
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate
  ];

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3");
  } else {
    args.push("-f", format);
  }

  args.push(videoUrl.href);

  downloadJobs.set(jobId, {
    id: jobId,
    baseName,
    status: "queued",
    progress: 0,
    message: "Queued...",
    created: Date.now()
  });
  runDownloadJob(jobId, args);
  res.status(202).json({ jobId, status: "queued", progress: 0 });
});

app.listen(PORT, () => {
  console.log(`Any Video Download running at http://localhost:${PORT}`);
});
