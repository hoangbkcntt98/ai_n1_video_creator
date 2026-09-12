import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("youtube", Path(__file__).parents[1] / "scripts/publish_youtube.py")
youtube = importlib.util.module_from_spec(spec)
spec.loader.exec_module(youtube)


class YouTubeOAuthTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {
            "YOUTUBE_CLIENT_ID": " test-client ",
            "YOUTUBE_CLIENT_SECRET": " test-secret ",
            "YOUTUBE_REFRESH_TOKEN": " test-refresh ",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def test_refresh_sends_trimmed_credentials(self):
        with patch.object(youtube, "request", return_value=(200, {}, b'{"access_token":"test-access"}')) as request:
            self.assertEqual(youtube.refresh_access_token(), "test-access")
        self.assertEqual(request.call_args.args[0], "https://oauth2.googleapis.com/token")
        self.assertEqual(request.call_args.args[3],
                         b"client_id=test-client&client_secret=test-secret&refresh_token=test-refresh&grant_type=refresh_token")

    def test_invalid_grant_explains_reauthorization_without_leaking_response(self):
        body = json.dumps({
            "error": "invalid_grant",
            "error_description": "secret-response-content",
            "access_token": "private-access-token",
        }).encode()
        with patch.object(youtube, "request", return_value=(400, {}, body)) as request:
            with self.assertRaises(RuntimeError) as caught:
                youtube.refresh_access_token()
        message = str(caught.exception)
        self.assertIn("Google OAuth HTTP 400 (invalid_grant)", message)
        self.assertIn("replace YOUTUBE_REFRESH_TOKEN", message)
        self.assertIn("7 days", message)
        for secret in ("secret-response-content", "private-access-token", "test-client", "test-secret", "test-refresh"):
            self.assertNotIn(secret, message)
        self.assertNotIn("quota", message)
        request.assert_called_once()

    def test_invalid_client_identifies_client_credentials(self):
        with patch.object(youtube, "request", return_value=(401, {}, b'{"error":"invalid_client"}')):
            with self.assertRaisesRegex(RuntimeError, "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET"):
                youtube.refresh_access_token()

    def test_malformed_oauth_response_uses_safe_fallback(self):
        for body in (b"not-json secret", b'{"error":"https://secret.test/token"}', b"null"):
            with self.subTest(body=body):
                message = str(youtube.api_error(400, body, oauth=True))
                self.assertIn("Google OAuth HTTP 400 (requestFailed)", message)
                self.assertNotIn("secret", message)

    def test_missing_credentials_fail_before_network_request(self):
        with patch.dict(os.environ, {"YOUTUBE_REFRESH_TOKEN": " "}), patch.object(youtube, "request") as request:
            with self.assertRaisesRegex(RuntimeError, "Missing YouTube OAuth"):
                youtube.refresh_access_token()
        request.assert_not_called()

class YouTubeUploadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / "video.mp4"
        self.file.write_bytes(b"12345678")
        self.job = {
            "videoFile": str(self.file), "title": "Test", "description": "説明",
            "privacy": "private", "madeForKids": False, "containsSyntheticMedia": True,
        }

    def execute(self, replies):
        with patch.object(youtube, "request", side_effect=replies) as request, \
                patch.object(youtube, "refresh_access_token", return_value="access-token") as refresh, \
                patch.object(youtube, "CHUNK_BYTES", 4), \
                patch.object(youtube.time, "sleep"), redirect_stdout(io.StringIO()):
            result = youtube.upload(self.job)
            return result, request.call_args_list, refresh.call_count

    def initial(self):
        return (200, {"Location": "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test"}, b"")

    def success(self):
        return (200, {}, json.dumps({"id": "abcdefghijk", "status": {"privacyStatus": "private"}}).encode())

    def test_chunk_upload_metadata_and_final_response(self):
        result, calls, _ = self.execute([self.initial(), (308, {"Range": "bytes=0-3"}, b""), self.success()])
        self.assertEqual(result["video_id"], "abcdefghijk")
        self.assertEqual(result["video_path"], str(self.file))
        metadata = json.loads(calls[0].args[3])
        self.assertTrue(metadata["status"]["containsSyntheticMedia"])
        self.assertFalse(metadata["status"]["selfDeclaredMadeForKids"])
        self.assertEqual(calls[1].args[2]["Content-Range"], "bytes 0-3/8")
        self.assertEqual(calls[2].args[2]["Content-Range"], "bytes 4-7/8")

    def test_lost_response_probes_offset_before_retry(self):
        _, calls, _ = self.execute([
            self.initial(), (503, {}, b""), (308, {"Range": "bytes=0-3"}, b""), self.success(),
        ])
        self.assertEqual(calls[2].args[2]["Content-Range"], "bytes */8")
        self.assertEqual(calls[2].args[3], b"")
        self.assertEqual(calls[3].args[3], b"5678")

    def test_refreshes_expired_access_token(self):
        _, _, refreshes = self.execute([self.initial(), (401, {}, b""), self.success()])
        self.assertEqual(refreshes, 2)

    def test_quota_error_not_retried(self):
        with self.assertRaisesRegex(RuntimeError, "quotaExceeded"):
            self.execute([self.initial(), (403, {}, b'{"error":{"errors":[{"reason":"quotaExceeded"}]}}')])

    def test_repeated_network_failure_stops(self):
        with self.assertRaisesRegex(RuntimeError, "interrupted after retries"):
            self.execute([self.initial()] + [(503, {}, b"")] * 6)

    def test_invalid_session_and_range_rejected(self):
        for url in ("http://www.googleapis.com/upload", "https://evil.test/upload", "https://www.googleapis.com.evil.test/upload"):
            with self.assertRaises(RuntimeError):
                youtube.validate_session_url(url)
        with self.assertRaises(RuntimeError):
            youtube.next_offset({"Range": "bytes=0-999"}, 8)

    def test_missing_video_id_warns_about_duplicate_upload(self):
        with self.assertRaisesRegex(RuntimeError, "Check YouTube Studio before retrying"):
            self.execute([self.initial(), (200, {}, b"{}")])


if __name__ == "__main__":
    unittest.main()
