import json
import os
import random
import re
import shutil
import subprocess
import threading
import time
import importlib.util
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DOWNLOAD_DIR = ROOT / "downloads"
PORT = int(os.environ.get("PORT", "3000"))
INFO_CACHE_TTL_SECONDS = 15 * 60
INFO_INFLIGHT_TTL_SECONDS = 2 * 60
INFO_QUICK_RETURN_SECONDS = 1.0
DOWNLOAD_JOB_TTL_SECONDS = 6 * 60 * 60
DOWNLOAD_CONCURRENT_FRAGMENTS = int(os.environ.get("AVD_CONCURRENT_FRAGMENTS", "12"))
DOWNLOAD_HTTP_CHUNK_SIZE = os.environ.get("AVD_HTTP_CHUNK_SIZE", "10M")
COOKIES_PATH = os.environ.get("AVD_COOKIES_PATH", "").strip()
COOKIES_BROWSER = os.environ.get("AVD_COOKIES_BROWSER", "").strip()
ALLOW_BROWSER_COOKIES = os.environ.get("AVD_ALLOW_BROWSER_COOKIES", "").strip().lower() in {"1", "true", "yes"}
FFMPEG_PATH = os.environ.get("AVD_FFMPEG_PATH", "").strip()
NAME_WORDS = {
    "adjectives": [
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
        "prime",
    ],
    "nouns": [
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
        "drift",
    ],
}

SUPPORTED_HOSTS = [
    "youtube.com",
    "youtu.be",
    "x.com",
    "twitter.com",
    "instagram.com",
    "facebook.com",
    "fb.watch",
    "dailymotion.com",
]

DOWNLOAD_DIR.mkdir(exist_ok=True)
EXECUTABLE_CACHE = {}
INFO_CACHE = {}
INFO_INFLIGHT = {}
INFO_INFLIGHT_LOCK = threading.Lock()
DOWNLOAD_JOBS = {}


def find_executable(name):
    if name in EXECUTABLE_CACHE:
        return EXECUTABLE_CACHE[name]

    if name == "ffmpeg" and FFMPEG_PATH:
        candidate = Path(FFMPEG_PATH)
        if candidate.exists():
            resolved = str(candidate)
            EXECUTABLE_CACHE[name] = resolved
            return resolved

    found = shutil.which(name)
    if found:
        EXECUTABLE_CACHE[name] = found
        return found

    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    program_files = Path(os.environ.get("ProgramFiles", "C:/Program Files"))
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"))
    candidates = [
        local_app_data / "Microsoft" / "WinGet" / "Links" / f"{name}.exe",
        program_files / name / f"{name}.exe",
        program_files_x86 / name / f"{name}.exe",
    ]

    if name == "ffmpeg":
        candidates.extend(
            [
                program_files / "Gyan" / "ffmpeg" / "bin" / "ffmpeg.exe",
                program_files / "FFmpeg" / "bin" / "ffmpeg.exe",
                Path("C:/ffmpeg/bin/ffmpeg.exe"),
            ]
        )

    for candidate in candidates:
        if candidate.exists():
            resolved = str(candidate)
            EXECUTABLE_CACHE[name] = resolved
            return resolved

    winget_packages = local_app_data / "Microsoft" / "WinGet" / "Packages"
    if winget_packages.exists():
        for package_dir in winget_packages.glob(f"*{name}*"):
            for candidate in package_dir.rglob(f"{name}.exe"):
                if candidate.exists():
                    resolved = str(candidate)
                    EXECUTABLE_CACHE[name] = resolved
                    return resolved
    return None


def is_supported_url(value):
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False

    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]

    return any(host == allowed or host.endswith(f".{allowed}") for allowed in SUPPORTED_HOSTS)


def url_host(value):
    parsed = urlparse(value)
    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    return host


def yt_dlp_available():
    if find_executable("yt-dlp"):
        return True
    return importlib.util.find_spec("yt_dlp") is not None


def ytdlp_command():
    executable = find_executable("yt-dlp")
    if executable:
        return [executable]
    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    return None


def ffmpeg_available():
    return find_executable("ffmpeg") is not None


def ffmpeg_location_args():
    ffmpeg = find_executable("ffmpeg")
    if not ffmpeg:
        return []
    return ["--ffmpeg-location", str(Path(ffmpeg).parent)]


def cookie_args():
    if not COOKIES_PATH:
        if COOKIES_BROWSER and ALLOW_BROWSER_COOKIES:
            return ["--cookies-from-browser", COOKIES_BROWSER]
        return []
    cookies_file = Path(COOKIES_PATH)
    if not cookies_file.exists():
        return []
    return ["--cookies", str(cookies_file)]


def has_cookie_config():
    return bool(COOKIES_PATH or (COOKIES_BROWSER and ALLOW_BROWSER_COOKIES))


def cookie_args_for_host(host):
    if host in {"youtube.com", "youtu.be"}:
        configured = cookie_args()
        if configured:
            return configured
    return []


def ytdlp_cookie_flags(host, use_cookies=True):
    if use_cookies:
        configured = cookie_args_for_host(host)
        if configured:
            return configured
    if host in {"youtube.com", "youtu.be"} and ALLOW_BROWSER_COOKIES:
        return ["--cookies-from-browser", COOKIES_BROWSER or "edge"]
    return ["--no-cookies"]


def is_cookie_access_error(text):
    lowered = text.lower()
    return (
        "dpapi" in lowered
        or "could not copy chrome cookie database" in lowered
        or "cookies-from-browser" in lowered
        or "chrome cookie database" in lowered
    )


def random_video_name():
    adjective = random.choice(NAME_WORDS["adjectives"])
    noun = random.choice(NAME_WORDS["nouns"])
    suffix = f"{random.randrange(16**4):04x}"
    return f"{adjective}-{noun}-{suffix}"


def quality_to_format(value, allow_progressive=False):
    selected = str(value or "1080").strip().lower()
    if selected == "source":
        if allow_progressive:
            return "best[ext=mp4]/best"
        return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
    if not re.match(r"^\d{3,4}$", selected):
        selected = "1080"

    height = max(144, min(int(selected), 8640))
    if allow_progressive:
        return f"best[height<={height}][ext=mp4]/best[height<={height}]/best"
    return (
        f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"best[height<={height}][ext=mp4]/best[height<={height}]"
    )


def default_quality_options():
    return [
        {
            "value": "1080",
            "label": "Best up to 1080p",
            "description": "Default for smooth downloads and broad device support.",
            "height": 1080,
            "default": True,
            "available": True,
        }
    ]


def build_quality_options(formats):
    heights = sorted(
        {
            int(item.get("height"))
            for item in formats
            if item.get("height") and item.get("vcodec") != "none"
        }
    )
    max_height = heights[-1] if heights else None
    has_1080_or_lower = any(height <= 1080 for height in heights) or not heights
    options = default_quality_options()
    options[0]["available"] = has_1080_or_lower

    for height in heights:
        if height > 1080:
            options.append(
                {
                    "value": str(height),
                    "label": f"Up to {height}p",
                    "description": "Higher quality available for this video.",
                    "height": height,
                    "default": False,
                    "available": True,
                }
            )

    if max_height and max_height > 1080:
        options.append(
            {
                "value": "source",
                "label": "Original maximum",
                "description": "Use the highest format the source exposes.",
                "height": max_height,
                "default": False,
                "available": True,
            }
        )

    return options, max_height


def thumbnail_from_info(info):
    if info.get("thumbnail"):
        return info.get("thumbnail")
    thumbnails = info.get("thumbnails") or []
    if thumbnails and isinstance(thumbnails[-1], dict):
        return thumbnails[-1].get("url")
    return None


def build_full_info_payload(info):
    source_formats = info.get("formats", [])
    quality_options, max_height = build_quality_options(source_formats)
    formats = []
    for item in source_formats[-30:]:
        if item.get("vcodec") == "none" and item.get("acodec") == "none":
            continue
        formats.append(
            {
                "format_id": item.get("format_id"),
                "ext": item.get("ext"),
                "resolution": item.get("resolution")
                or f"{item.get('width') or '?'}x{item.get('height') or '?'}",
                "fps": item.get("fps"),
                "filesize": item.get("filesize") or item.get("filesize_approx"),
                "note": item.get("format_note"),
            }
        )

    return {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "thumbnail": thumbnail_from_info(info),
        "uploader": info.get("uploader") or info.get("channel"),
        "webpage_url": info.get("webpage_url"),
        "extractor": info.get("extractor_key"),
        "maxHeight": max_height,
        "qualityOptions": quality_options,
        "formats": formats,
        "qualityPending": False,
    }


def build_quick_info_payload(info):
    return {
        "title": info.get("title") or info.get("fulltitle") or "",
        "duration": info.get("duration"),
        "thumbnail": thumbnail_from_info(info),
        "uploader": info.get("uploader") or info.get("channel") or "",
        "webpage_url": info.get("webpage_url") or info.get("url"),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "maxHeight": None,
        "qualityOptions": default_quality_options(),
        "formats": [],
        "qualityPending": True,
    }


def payload_from_quick_info(info):
    if info.get("formats") and thumbnail_from_info(info):
        return build_full_info_payload(info)
    return build_quick_info_payload(info)


def fetch_youtube_oembed(video_url):
    if url_host(video_url) not in {"youtube.com", "youtu.be"}:
        return None

    encoded_url = quote(video_url, safe="")
    oembed_url = f"https://www.youtube.com/oembed?url={encoded_url}&format=json"
    request = Request(oembed_url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urlopen(request, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

    return {
        "title": payload.get("title"),
        "thumbnail": payload.get("thumbnail_url"),
        "uploader": payload.get("author_name"),
        "extractor": "YouTube",
        "url": video_url,
    }


def youtube_id_from_url(video_url):
    parsed = urlparse(video_url)
    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]

    if host == "youtu.be":
        return parsed.path.lstrip("/").split("/")[0]

    if host.endswith("youtube.com"):
        if parsed.path.startswith("/watch"):
            return (parse_qs(parsed.query).get("v") or [""])[0]
        if parsed.path.startswith("/shorts/"):
            return parsed.path.split("/")[2]
        if parsed.path.startswith("/embed/"):
            return parsed.path.split("/")[2]
    return ""


def youtube_thumbnail_from_url(video_url):
    video_id = youtube_id_from_url(video_url)
    if not video_id:
        return None
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def cache_get(key):
    cached = INFO_CACHE.get(key)
    if not cached:
        return None
    created, payload = cached
    if time.time() - created > INFO_CACHE_TTL_SECONDS:
        INFO_CACHE.pop(key, None)
        return None
    copy = dict(payload)
    copy["cached"] = True
    return copy


def cache_set(key, payload):
    INFO_CACHE[key] = (time.time(), dict(payload))


def inflight_wait(key, timeout):
    with INFO_INFLIGHT_LOCK:
        entry = INFO_INFLIGHT.get(key)
    if not entry:
        return None
    if entry["event"].wait(timeout):
        return entry.get("result")
    return None


def inflight_start(key):
    with INFO_INFLIGHT_LOCK:
        if key in INFO_INFLIGHT:
            return INFO_INFLIGHT[key]
        entry = {"event": threading.Event(), "created": time.time(), "result": None}
        INFO_INFLIGHT[key] = entry
        return entry


def inflight_finish(key, result):
    with INFO_INFLIGHT_LOCK:
        entry = INFO_INFLIGHT.get(key)
        if entry:
            entry["result"] = result
            entry["event"].set()


def prune_inflight():
    now = time.time()
    with INFO_INFLIGHT_LOCK:
        expired = [key for key, entry in INFO_INFLIGHT.items() if now - entry["created"] > INFO_INFLIGHT_TTL_SECONDS]
        for key in expired:
            INFO_INFLIGHT.pop(key, None)


def parse_ytdlp_json(raw):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        lines = [line for line in raw.splitlines() if line.strip()]
        if not lines:
            raise
        return json.loads(lines[-1])


def run_ytdlp(args, timeout=None, host=None):
    command = ytdlp_command()
    if not command:
        raise RuntimeError("yt-dlp is not installed or is not available in PATH.")

    command = [*command, *ffmpeg_location_args(), *ytdlp_cookie_flags(host or "", use_cookies=True), *args]
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        raise RuntimeError("yt-dlp timed out while reading video metadata.")

    if process.returncode != 0:
        raise RuntimeError(stderr.strip() or f"yt-dlp exited with {process.returncode}")
    return stdout


def prune_download_jobs():
    now = time.time()
    expired = []
    for job_id, job in DOWNLOAD_JOBS.items():
        status = job.get("status")
        age = now - float(job.get("created") or now)
        if status in {"done", "error"} and age > DOWNLOAD_JOB_TTL_SECONDS:
            expired.append(job_id)
    for job_id in expired:
        DOWNLOAD_JOBS.pop(job_id, None)


def run_download_job(job_id, args, fallback_args=None):
    job = DOWNLOAD_JOBS[job_id]
    progress_pattern = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")

    def number_or_none(value):
        try:
            if value in ("", "NA", "None"):
                return None
            return float(value)
        except ValueError:
            return None

    def set_progress(value, message):
        previous = float(job.get("progress") or 0)
        job["progress"] = max(previous, min(99, value))
        job["message"] = message

    def run_process(command):
        job.update({"status": "running", "message": "Connecting to source..."})
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        saved_path = None
        tail = []
        assert process.stdout is not None
        for line in process.stdout:
            clean_line = line.strip()
            if not clean_line:
                continue

            tail.append(clean_line)
            if len(tail) > 8:
                tail.pop(0)

            if clean_line.startswith("__AVD_PROGRESS__:"):
                parts = clean_line.split(":")
                downloaded = number_or_none(parts[1] if len(parts) > 1 else "")
                total = number_or_none(parts[2] if len(parts) > 2 else "")
                estimate = number_or_none(parts[3] if len(parts) > 3 else "")
                total_bytes = total or estimate
                if downloaded is not None and total_bytes:
                    set_progress((downloaded / total_bytes) * 100, "Downloading...")
                    job["downloadedBytes"] = int(downloaded)
                    job["totalBytes"] = int(total_bytes)
                continue

            progress = progress_pattern.search(clean_line)
            if progress:
                set_progress(float(progress.group(1)), "Downloading...")
                continue

            if clean_line.lower().startswith(str(DOWNLOAD_DIR).lower()):
                candidate = Path(clean_line)
                if candidate.exists() and candidate.parent.resolve() == DOWNLOAD_DIR.resolve():
                    saved_path = candidate
                    job["progress"] = max(float(job.get("progress") or 0), 99)
                    job["message"] = "Finalizing file..."
            elif clean_line.startswith("[Merger]"):
                job["progress"] = max(float(job.get("progress") or 0), 98)
                job["message"] = "Merging video and audio..."
            elif clean_line.startswith("[ExtractAudio]"):
                job["progress"] = max(float(job.get("progress") or 0), 98)
                job["message"] = "Converting audio..."
            elif clean_line.startswith("[download] Destination"):
                job["message"] = "Downloading..."

        code = process.wait()
        if code != 0:
            tail_text = " | ".join(tail[-3:]) if tail else ""
            raise RuntimeError(f"yt-dlp exited with {code} {tail_text}".strip())

        if not saved_path:
            base_name = job.get("baseName") or job_id
            for candidate in DOWNLOAD_DIR.glob(f"{base_name}.*"):
                if candidate.exists():
                    saved_path = candidate
                    break

        if not saved_path:
            raise RuntimeError("Download finished, but the output file could not be found.")

        return saved_path

    try:
        yt_dlp = ytdlp_command()
        if not yt_dlp:
            raise RuntimeError("yt-dlp is not installed or is not available in PATH.")
        host = job.get("host") or ""

        def build_command(base_args, include_cookies=True):
            cookie_part = ytdlp_cookie_flags(host, use_cookies=include_cookies)
            return [*yt_dlp, *ffmpeg_location_args(), *cookie_part, *base_args]

        def build_command_with_cookies(base_args, cookie_flags):
            return [*yt_dlp, *ffmpeg_location_args(), *cookie_flags, *base_args]

        primary_command = build_command(args, include_cookies=True)
        fallback_command = build_command(fallback_args, include_cookies=True) if fallback_args else None
        no_cookie_primary = build_command(args, include_cookies=False)
        no_cookie_fallback = build_command(fallback_args, include_cookies=False) if fallback_args else None

        saved_path = run_process(primary_command)
        job.update(
            {
                "status": "done",
                "progress": 100,
                "message": "Download ready.",
                "fileName": saved_path.name,
                "fileSize": saved_path.stat().st_size,
                "downloadUrl": f"/downloads/{saved_path.name}",
            }
        )
    except Exception as error:
        if fallback_command:
            try:
                job["message"] = "Retrying with compatibility mode..."
                saved_path = run_process(fallback_command)
                job.update(
                    {
                        "status": "done",
                        "progress": 100,
                        "message": "Download ready.",
                        "fileName": saved_path.name,
                        "fileSize": saved_path.stat().st_size,
                        "downloadUrl": f"/downloads/{saved_path.name}",
                    }
                )
                return
            except Exception as retry_error:
                error = retry_error

        if is_cookie_access_error(str(error)):
            try:
                job["message"] = "Retrying without browser cookies..."
                saved_path = run_process(no_cookie_primary)
                job.update(
                    {
                        "status": "done",
                        "progress": 100,
                        "message": "Download ready.",
                        "fileName": saved_path.name,
                        "fileSize": saved_path.stat().st_size,
                        "downloadUrl": f"/downloads/{saved_path.name}",
                    }
                )
                return
            except Exception as retry_error:
                error = retry_error

            if no_cookie_fallback:
                try:
                    job["message"] = "Retrying without cookies (compatibility)..."
                    saved_path = run_process(no_cookie_fallback)
                    job.update(
                        {
                            "status": "done",
                            "progress": 100,
                            "message": "Download ready.",
                            "fileName": saved_path.name,
                            "fileSize": saved_path.stat().st_size,
                            "downloadUrl": f"/downloads/{saved_path.name}",
                        }
                    )
                    return
                except Exception as retry_error:
                    error = retry_error

        error_text = str(error)
        if is_cookie_access_error(error_text):
            error_text = (
                "Browser cookies are not available in this environment. "
                "Use AVD_COOKIES_PATH with an exported cookies file or disable browser cookies."
            )
        elif "Sign in to confirm" in error_text or "cookies" in error_text:
            if host in {"youtube.com", "youtu.be"} and not has_cookie_config() and ALLOW_BROWSER_COOKIES:
                for browser_name in ("edge", "chrome"):
                    try:
                        job["message"] = f"Retrying with {browser_name} cookies..."
                        saved_path = run_process(
                            build_command_with_cookies(args, ["--cookies-from-browser", browser_name])
                        )
                        job.update(
                            {
                                "status": "done",
                                "progress": 100,
                                "message": "Download ready.",
                                "fileName": saved_path.name,
                                "fileSize": saved_path.stat().st_size,
                                "downloadUrl": f"/downloads/{saved_path.name}",
                            }
                        )
                        return
                    except Exception as retry_error:
                        error_text = str(retry_error)

            error_text = (
                "YouTube needs browser cookies. Log in to YouTube in your browser and set AVD_COOKIES_BROWSER=edge (or chrome), "
                "or use AVD_COOKIES_PATH with an exported cookies file."
            )
        job.update(
            {
                "status": "error",
                "message": error_text,
                "error": "Download failed. This app cannot access private, restricted, DRM-protected, or unsupported videos.",
            }
        )


def json_response(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length > 1_000_000:
        raise ValueError("Request body is too large.")
    return json.loads(handler.rfile.read(length).decode("utf-8") or "{}")


class AppHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        clean_path = unquote(urlparse(self.path).path)
        if clean_path.startswith("/downloads/"):
            file_name = Path(clean_path).name.replace('"', "")
            self.send_header("Content-Disposition", f'attachment; filename="{file_name}"')
        super().end_headers()

    def translate_path(self, path):
        clean_path = unquote(urlparse(path).path)
        if clean_path.startswith("/downloads/"):
            relative = clean_path.removeprefix("/downloads/")
            return str((DOWNLOAD_DIR / relative).resolve())
        if clean_path == "/":
            clean_path = "/index.html"
        return str((PUBLIC_DIR / clean_path.lstrip("/")).resolve())

    def do_GET(self):
        if self.path.startswith("/api/health"):
            return json_response(
                self,
                200,
                {
                    "ok": True,
                    "ytDlpInstalled": yt_dlp_available(),
                    "ffmpegInstalled": ffmpeg_available(),
                    "supportedHosts": SUPPORTED_HOSTS,
                },
            )
        if self.path.startswith("/api/download-status"):
            prune_download_jobs()
            query = parse_qs(urlparse(self.path).query)
            job_id = (query.get("id") or [""])[0]
            job = DOWNLOAD_JOBS.get(job_id)
            if not job:
                return json_response(self, 404, {"error": "Download job was not found."})
            return json_response(self, 200, job)
        return super().do_GET()

    def do_POST(self):
        try:
            data = read_json(self)
        except Exception:
            return json_response(self, 400, {"error": "Invalid JSON request."})

        if self.path.startswith("/api/info"):
            return self.handle_info(data)
        if self.path.startswith("/api/download"):
            return self.handle_download(data)
        return json_response(self, 404, {"error": "Not found."})

    def handle_info(self, data):
        prune_inflight()
        video_url = str(data.get("url", "")).strip()
        quick = bool(data.get("quick"))
        if not is_supported_url(video_url):
            return json_response(self, 400, {"error": "Paste a valid URL from a supported video platform."})

        if not yt_dlp_available():
            return json_response(
                self,
                503,
                {
                    "error": "yt-dlp is not installed or is not available in PATH.",
                    "installHint": "Install it with: winget install yt-dlp.yt-dlp",
                },
            )

        full_key = f"full:{video_url}"
        full_cached = cache_get(full_key)
        if full_cached:
            return json_response(self, 200, full_cached)

        if quick:
            quick_key = f"quick:{video_url}"
            quick_cached = cache_get(quick_key)
            if quick_cached:
                return json_response(self, 200, quick_cached)

            inflight_result = inflight_wait(quick_key, INFO_QUICK_RETURN_SECONDS)
            if inflight_result:
                if inflight_result.get("ok"):
                    return json_response(self, 200, inflight_result["payload"])
                return json_response(self, 200, inflight_result["fallback"])

            inflight_start(quick_key)

            oembed_info = fetch_youtube_oembed(video_url)
            if oembed_info:
                payload = build_quick_info_payload(oembed_info)
                cache_set(quick_key, payload)
                inflight_finish(quick_key, {"ok": True, "payload": payload})
                return json_response(self, 200, payload)

            yt_thumbnail = youtube_thumbnail_from_url(video_url)
            if yt_thumbnail:
                payload = build_quick_info_payload(
                    {
                        "thumbnail": yt_thumbnail,
                        "extractor": "YouTube",
                        "url": video_url,
                    }
                )
                cache_set(quick_key, payload)
                inflight_finish(quick_key, {"ok": True, "payload": payload})
                return json_response(self, 200, payload)

            def fetch_quick_info():
                try:
                    raw = run_ytdlp(
                        [
                            "--dump-json",
                            "--no-playlist",
                            "--no-warnings",
                            "--skip-download",
                            "--no-check-formats",
                            "--socket-timeout",
                            "5",
                            "--retries",
                            "1",
                            "--extractor-retries",
                            "1",
                            video_url,
                        ],
                        timeout=8,
                        host=url_host(video_url),
                    )
                    payload = payload_from_quick_info(parse_ytdlp_json(raw))
                    cache_set(quick_key, payload)
                    if not payload.get("qualityPending"):
                        cache_set(full_key, payload)
                    inflight_finish(quick_key, {"ok": True, "payload": payload})
                except Exception:
                    payload = build_quick_info_payload({"url": video_url})
                    cache_set(quick_key, payload)
                    inflight_finish(quick_key, {"ok": False, "fallback": payload})

            threading.Thread(target=fetch_quick_info, daemon=True).start()

            payload = build_quick_info_payload({"url": video_url})
            cache_set(quick_key, payload)
            return json_response(self, 200, payload)

        inflight_result = inflight_wait(full_key, 35)
        if inflight_result:
            if inflight_result.get("ok"):
                return json_response(self, 200, inflight_result["payload"])
            return json_response(self, 422, inflight_result["error"])

        inflight_start(full_key)

        try:
            raw = run_ytdlp(
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
                    video_url,
                ],
                timeout=35,
                host=url_host(video_url),
            )
            payload = build_full_info_payload(parse_ytdlp_json(raw))
            cache_set(full_key, payload)
            inflight_finish(full_key, {"ok": True, "payload": payload})
            return json_response(self, 200, payload)
        except Exception as error:
            inflight_finish(
                full_key,
                {
                    "ok": False,
                    "error": {
                        "error": "Could not read this video. Make sure it is public or that you have direct permission to access it.",
                        "detail": str(error),
                    },
                },
            )
            return json_response(
                self,
                422,
                {
                    "error": "Could not read this video. Make sure it is public or that you have direct permission to access it.",
                    "detail": str(error),
                },
            )

    def handle_download(self, data):
        prune_download_jobs()
        video_url = str(data.get("url", "")).strip()
        quality = str(data.get("quality") or "1080")
        has_ffmpeg = ffmpeg_available()
        video_format = quality_to_format(quality, allow_progressive=not has_ffmpeg)
        audio_only = bool(data.get("audioOnly"))
        host = url_host(video_url)

        if not is_supported_url(video_url):
            return json_response(self, 400, {"error": "Paste a valid URL from a supported video platform."})
        if not yt_dlp_available():
            return json_response(
                self,
                503,
                {
                    "error": "yt-dlp is not installed or is not available in PATH.",
                    "installHint": "Install it with: winget install yt-dlp.yt-dlp",
                },
            )
        if host in {"linkedin.com", "lnkd.in"} and not cookie_args():
            return json_response(
                self,
                403,
                {
                    "error": "LinkedIn downloads require cookies from a logged-in browser session.",
                    "installHint": "Set AVD_COOKIES_PATH or AVD_COOKIES_BROWSER=edge and restart the server.",
                },
            )
        if audio_only and not has_ffmpeg:
            return json_response(
                self,
                503,
                {
                    "error": "ffmpeg is required for audio-only downloads.",
                    "installHint": "Install it with: winget install Gyan.FFmpeg",
                },
            )

        job_id = f"{int(time.time())}-{random.randrange(16**8):08x}"
        base_name = random_video_name()
        output_template = str(DOWNLOAD_DIR / f"{base_name}.%(ext)s")
        host = url_host(video_url)
        args = [
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
            str(DOWNLOAD_CONCURRENT_FRAGMENTS),
            "--http-chunk-size",
            DOWNLOAD_HTTP_CHUNK_SIZE,
            "--socket-timeout",
            "20",
            "--no-mtime",
            "--print",
            "after_move:filepath",
            "-o",
            output_template,
        ]

        if host in {"youtube.com", "youtu.be"}:
            args.extend(
                [
                    "--extractor-args",
                    "youtube:player_client=android,web",
                    "--geo-bypass",
                ]
            )

        if has_ffmpeg:
            args.extend(["--merge-output-format", "mp4"])

        fallback_args = None
        if audio_only:
            args.extend(["-x", "--audio-format", "mp3"])
        else:
            args.extend(["-f", video_format])
            fallback_args = list(args)
            if len(fallback_args) >= 2 and fallback_args[-2] == "-f":
                fallback_args = fallback_args[:-2]
            if has_ffmpeg:
                fallback_format = "bestvideo+bestaudio/best[ext=mp4]/best"
            else:
                fallback_format = "best"
            fallback_args.extend(["-f", fallback_format])
        args.append(video_url)
        if fallback_args:
            fallback_args.append(video_url)

        DOWNLOAD_JOBS[job_id] = {
            "id": job_id,
            "baseName": base_name,
            "host": host,
            "status": "queued",
            "progress": 0,
            "message": "Queued...",
            "created": time.time(),
        }
        thread = threading.Thread(target=run_download_job, args=(job_id, args, fallback_args), daemon=True)
        thread.start()
        return json_response(self, 202, {"jobId": job_id, "status": "queued", "progress": 0})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), AppHandler)
    print(f"Any Video Download running at http://0.0.0.0:{PORT}")
    server.serve_forever()
