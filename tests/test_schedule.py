import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

from schedule import (
    MAX_THUMBNAIL_SIZE,
    _create_live_stream,
    _format_stream_title,
    _scheduled_datetimes,
    _validate_thumbnail,
)


class ScheduledDatetimesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.zone = ZoneInfo("Europe/Paris")
        self.now = datetime(2026, 7, 19, 12, 0, tzinfo=self.zone)

    def test_one_time_weekly(self) -> None:
        result = _scheduled_datetimes(
            3, "20-07-2026", ["20:00"], "weekly", self.zone, self.now
        )

        self.assertEqual(
            [(item.strftime("%d-%m-%Y"), item.strftime("%H:%M")) for item in result],
            [
                ("20-07-2026", "20:00"),
                ("27-07-2026", "20:00"),
                ("03-08-2026", "20:00"),
            ],
        )

    def test_several_times_daily(self) -> None:
        result = _scheduled_datetimes(
            2,
            "20-07-2026",
            ["20:00", "08:00"],
            "daily",
            self.zone,
            self.now,
        )

        self.assertEqual(
            [item.strftime("%d-%m-%Y %H:%M") for item in result],
            [
                "20-07-2026 08:00",
                "20-07-2026 20:00",
                "21-07-2026 08:00",
                "21-07-2026 20:00",
            ],
        )

    def test_past_first_time_advances_whole_group(self) -> None:
        result = _scheduled_datetimes(
            1,
            "19-07-2026",
            ["10:00", "18:00"],
            "daily",
            self.zone,
            self.now,
        )

        self.assertEqual(
            [item.strftime("%d-%m-%Y %H:%M") for item in result],
            ["20-07-2026 10:00", "20-07-2026 18:00"],
        )

    def test_rejects_duplicate_times(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate"):
            _scheduled_datetimes(
                1,
                "20-07-2026",
                ["08:00", "08:00"],
                "daily",
                self.zone,
                self.now,
            )

    def test_formats_session_number_and_datetime(self) -> None:
        scheduled = datetime(2026, 7, 20, 8, 0, tzinfo=self.zone)

        self.assertEqual(
            _format_stream_title(
                "Session {session} - %d.%m.%y at %H:%M", scheduled, 3
            ),
            "Session 3 - 20.07.26 at 08:00",
        )
        self.assertEqual(
            _format_stream_title("Session {session:02d}", scheduled, 3),
            "Session 03",
        )

    def test_numbers_multiple_daily_sessions_chronologically(self) -> None:
        scheduled = _scheduled_datetimes(
            2,
            "20-07-2026",
            ["20:00", "08:00"],
            "daily",
            self.zone,
            self.now,
        )

        titles = [
            _format_stream_title("Session {session}", item, number)
            for number, item in enumerate(scheduled, start=1)
        ]

        self.assertEqual(
            titles, ["Session 1", "Session 2", "Session 3", "Session 4"]
        )

    def test_title_without_session_placeholder_is_unchanged(self) -> None:
        scheduled = datetime(2026, 7, 20, 8, 0, tzinfo=self.zone)
        self.assertEqual(
            _format_stream_title("Session on %d-%m-%Y", scheduled, 1),
            "Session on 20-07-2026",
        )

    def test_rejects_invalid_session_number_format(self) -> None:
        scheduled = datetime(2026, 7, 20, 8, 0, tzinfo=self.zone)
        with self.assertRaisesRegex(ValueError, "Invalid session number format"):
            _format_stream_title("Session {session:invalid}", scheduled, 1)

    def test_thumbnail_is_optional(self) -> None:
        self.assertIsNone(_validate_thumbnail(None))

    def test_accepts_png_and_jpeg_thumbnails(self) -> None:
        with TemporaryDirectory() as directory:
            png = Path(directory, "thumbnail.png")
            jpeg = Path(directory, "thumbnail.jpg")
            png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"image data")
            jpeg.write_bytes(b"\xff\xd8\xff" + b"image data")

            self.assertEqual(_validate_thumbnail(str(png)), (png, "image/png"))
            self.assertEqual(_validate_thumbnail(str(jpeg)), (jpeg, "image/jpeg"))

    def test_rejects_missing_or_invalid_thumbnail(self) -> None:
        with TemporaryDirectory() as directory:
            missing = Path(directory, "missing.png")
            invalid = Path(directory, "thumbnail.gif")
            invalid.write_bytes(b"not an image")

            with self.assertRaisesRegex(ValueError, "does not exist"):
                _validate_thumbnail(str(missing))
            with self.assertRaisesRegex(ValueError, "valid PNG or JPEG"):
                _validate_thumbnail(str(invalid))

    def test_rejects_thumbnail_larger_than_two_mb(self) -> None:
        with TemporaryDirectory() as directory:
            oversized = Path(directory, "thumbnail.png")
            with oversized.open("wb") as image:
                image.write(b"\x89PNG\r\n\x1a\n")
                image.truncate(MAX_THUMBNAIL_SIZE + 1)

            with self.assertRaisesRegex(ValueError, "must not exceed 2 MB"):
                _validate_thumbnail(str(oversized))

    def test_creates_reusable_shared_stream(self) -> None:
        youtube = MagicMock()
        youtube.liveStreams.return_value.insert.return_value.execute.return_value = {
            "id": "stream-id",
            "cdn": {"ingestionInfo": {"streamName": "stream-key"}},
        }

        result = _create_live_stream(
            youtube,
            "Shared stream",
            "Description",
            reusable=True,
        )

        self.assertEqual(result, ("stream-key", "stream-id"))
        insert = youtube.liveStreams.return_value.insert
        self.assertTrue(insert.call_args.kwargs["body"]["contentDetails"]["isReusable"])


if __name__ == "__main__":
    unittest.main()
