#!/usr/bin/env python3
"""Upload MP4 using OAuth and YouTube's resumable protocol (Python 3.9+).

Credentials come from environment only. No third-party Python packages needed.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

CHUNK_BYTES = 8 * 1024 * 1024  # Multiple of YouTube's 256 KiB chunk size.
RETRYABLE = {500, 502, 503, 504}


def request(url, method, headers=None, data=None):
    try:
        with urlopen(Request(url, data=data, headers=headers or {}, method=method), timeout=120) as response:
            return response.status, response.headers, response.read()
    except HTTPError as error:
        return error.code, error.headers, error.read()


def api_error(status, body):
    # Never log response URLs, OAuth responses, cookies, or access tokens.
    reason = ""
    try:
        payload = json.loads(body)
        error = payload.get("error", {})
        if isinstance(error, dict):
            reasons = error.get("errors", [])
            reason = reasons[0].get("reason", "") if reasons else error.get("status", "")
        elif isinstance(error, str):
            reason = error
    except (ValueError, TypeError, AttributeError, IndexError):
        pass
    safe_reason = reason if isinstance(reason, str) and re.fullmatch(r"[A-Za-z0-9_]+", reason) else "requestFailed"
    return RuntimeError("YouTube API HTTP {} ({}). Check credentials, quota, and channel permissions.".format(status, safe_reason))


def refresh_access_token():
    names = ("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN")
    if any(not os.environ.get(name, "").strip() for name in names):
        raise RuntimeError("Missing YouTube OAuth environment variables.")
    status, _, body = request(
        "https://oauth2.googleapis.com/token", "POST",
        {"Content-Type": "application/x-www-form-urlencoded"},
        urlencode({
            "client_id": os.environ[names[0]].strip(),
            "client_secret": os.environ[names[1]].strip(),
            "refresh_token": os.environ[names[2]].strip(),
            "grant_type": "refresh_token",
        }).encode(),
    )
    if status != 200:
        raise api_error(status, body)
    token = json.loads(body).get("access_token")
    if not token:
        raise RuntimeError("Google did not return an access token.")
    return token


def validate_session_url(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ("www.googleapis.com", "youtube.googleapis.com"):
        raise RuntimeError("YouTube returned an invalid resumable upload URL.")
    return url


def next_offset(headers, total):
    value = headers.get("Range")
    if not value:
        return 0
    match = re.fullmatch(r"bytes=0-(\d+)", value)
    if not match or int(match.group(1)) >= total:
        raise RuntimeError("YouTube returned an invalid upload range.")
    return int(match.group(1)) + 1


def upload(job):
    video = Path(job["videoFile"])
    total = video.stat().st_size
    if video.suffix.lower() != ".mp4" or total <= 0:
        raise RuntimeError("A non-empty MP4 file is required.")
    token = refresh_access_token()
    metadata = {
        "snippet": {"title": job["title"], "description": job["description"], "categoryId": "27"},
        "status": {
            "privacyStatus": job["privacy"],
            "selfDeclaredMadeForKids": job["madeForKids"],
            "containsSyntheticMedia": job["containsSyntheticMedia"],
        },
    }
    status, headers, body = request(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
        "POST",
        {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(total),
            "X-Upload-Content-Type": "video/mp4",
        },
        json.dumps(metadata).encode("utf-8"),
    )
    if status not in (200, 201):
        raise api_error(status, body)
    session = validate_session_url(headers.get("Location", ""))
    offset, failures, probe = 0, 0, False
    with video.open("rb") as stream:
        while True:
            stream.seek(offset)
            chunk = b"" if probe else stream.read(CHUNK_BYTES)
            if not probe and not chunk:
                raise RuntimeError("Video changed during upload, or final response was missing.")
            content_range = "bytes */{}".format(total) if probe else "bytes {}-{}/{}".format(offset, offset + len(chunk) - 1, total)
            try:
                status, headers, body = request(session, "PUT", {
                    "Authorization": "Bearer " + token,
                    "Content-Type": "video/mp4",
                    "Content-Length": str(len(chunk)),
                    "Content-Range": content_range,
                }, chunk)
            except (URLError, TimeoutError, OSError):
                status, headers, body = 503, {}, b""
            if status in (200, 201):
                result = json.loads(body)
                video_id = result.get("id")
                if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                    raise RuntimeError("Upload completed, but YouTube returned no valid video ID. Check YouTube Studio before retrying.")
                return {
                    "success": True, "video_id": video_id,
                    "video_path": str(video),
                    "privacy_status": result.get("status", {}).get("privacyStatus", job["privacy"]),
                }
            if status == 308:
                received = next_offset(headers, total)
                if received <= offset and not probe:
                    failures += 1
                    if failures > 5:
                        raise RuntimeError("YouTube upload made no progress. Check YouTube Studio before retrying.")
                    time.sleep(2 ** failures)
                elif received > offset:
                    failures = 0
                    print("Upload progress: {:.1f}%".format(received / total * 100), flush=True)
                offset, probe = received, False
                continue
            if status == 401 or status in RETRYABLE:
                failures += 1
                if failures > 5:
                    raise RuntimeError("YouTube upload interrupted after retries. Check YouTube Studio before retrying.")
                time.sleep(2 ** failures)
                if status == 401:
                    token = refresh_access_token()
                # Query server offset before retrying: the previous chunk may
                # have been accepted even if its response was lost.
                probe = True
                continue
            raise api_error(status, body)


def main():
    try:
        with open(sys.argv[1], encoding="utf-8") as source:
            job = json.load(source)
        print("Starting YouTube upload ({}).".format(job["privacy"]), flush=True)
        result = upload(job)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as error:
        # Network exception strings can contain resumable session URLs.
        message = str(error) if isinstance(error, RuntimeError) else "YouTube upload failed ({}). Check server configuration and video file.".format(type(error).__name__)
        print(message, file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
