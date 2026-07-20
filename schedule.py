import os
import pickle
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional
from zoneinfo import ZoneInfo

from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from jsonargparse import auto_cli

# --- Configuration ---
CLIENT_SECRETS_FILE = "client_secrets.json"
SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
API_SERVICE_NAME = "youtube"
API_VERSION = "v3"
MAX_THUMBNAIL_SIZE = 2_000_000
SESSION_FORMAT_PATTERN = re.compile(
    r"(?<!\{)\{session(?::(?P<format>[^{}]+))?\}(?!\})"
)
# Note: Playlist is now optional and provided via CLI.


def get_authenticated_service():
    """Authenticates the user and returns a YouTube API service object."""
    creds = None
    if os.path.exists("token.pickle"):
        with open("token.pickle", "rb") as token:
            creds = pickle.load(token)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(
                CLIENT_SECRETS_FILE, SCOPES
            )
            creds = flow.run_local_server(port=0)
        with open("token.pickle", "wb") as token:
            pickle.dump(creds, token)
    return build(API_SERVICE_NAME, API_VERSION, credentials=creds)


def _isoformat_utc(dt: datetime) -> str:
    """Return RFC3339 UTC timestamp string accepted by YouTube (e.g., 2025-09-07T12:00:00Z)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    # YouTube accepts trailing 'Z' for UTC
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _format_stream_title(
    template: str, scheduled_local: datetime, session_number: int
) -> str:
    """Apply the custom session token, then the existing strftime tokens."""

    def replace_session(match: re.Match) -> str:
        format_spec = match.group("format") or ""
        try:
            return format(session_number, format_spec)
        except ValueError as e:
            raise ValueError(
                f"Invalid session number format in '{match.group(0)}'"
            ) from e

    title_with_session = SESSION_FORMAT_PATTERN.sub(replace_session, template)
    return scheduled_local.strftime(title_with_session)


def _validate_thumbnail(
    thumbnail: Optional[str],
) -> Optional[tuple[Path, str]]:
    """Validate a thumbnail path and return its path and detected MIME type."""
    if thumbnail is None:
        return None

    path = Path(thumbnail).expanduser()
    if not path.is_file():
        raise ValueError(f"Thumbnail file does not exist: {path}")

    if path.stat().st_size > MAX_THUMBNAIL_SIZE:
        raise ValueError("Thumbnail file must not exceed 2 MB")

    try:
        with path.open("rb") as image:
            header = image.read(16)
    except OSError as e:
        raise ValueError(f"Thumbnail file cannot be read: {path}") from e

    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        mime_type = "image/png"
    elif header.startswith(b"\xff\xd8\xff"):
        mime_type = "image/jpeg"
    else:
        raise ValueError("Thumbnail must be a valid PNG or JPEG file")

    return path, mime_type


def _scheduled_datetimes(
    n: int,
    start_date: str,
    start_times: List[str],
    cadence: Literal["daily", "weekly"],
    zone: ZoneInfo,
    now_local: Optional[datetime] = None,
) -> List[datetime]:
    """Build local scheduled datetimes without making any API requests."""
    if n < 1:
        raise ValueError("n must be at least 1")
    if cadence not in ("daily", "weekly"):
        raise ValueError("cadence must be 'daily' or 'weekly'")

    try:
        base_date = datetime.strptime(start_date, "%d-%m-%Y").date()
    except ValueError as e:
        raise ValueError(
            "start_date must be in %d-%m-%Y format, e.g. 07-09-2025"
        ) from e

    if not start_times:
        raise ValueError("start_time must contain at least one time")

    parsed_times = []
    for value in start_times:
        try:
            parsed_times.append(datetime.strptime(value, "%H:%M").time())
        except ValueError as e:
            raise ValueError(
                f"Invalid start time '{value}'; use %H:%M 24-hour format, e.g. 18:30"
            ) from e

    if len(set(parsed_times)) != len(parsed_times):
        raise ValueError("start_time contains a duplicate time")

    parsed_times.sort()
    cadence_step = timedelta(days=1 if cadence == "daily" else 7)
    now_local = now_local or datetime.now(zone)

    # Keep all sessions for a cadence period together. If even the earliest
    # time on the first date has passed, advance the entire day/week.
    first_date = base_date
    while datetime.combine(first_date, parsed_times[0], tzinfo=zone) < now_local:
        first_date += cadence_step

    return [
        datetime.combine(first_date + cadence_step * period, start_time, tzinfo=zone)
        for period in range(n)
        for start_time in parsed_times
    ]


def _create_live_stream(
    youtube,
    title: str,
    description: Optional[str],
    *,
    reusable: bool,
) -> tuple[str, str]:
    """Create a YouTube live stream and return its stream key and ID."""
    response = (
        youtube.liveStreams()
        .insert(
            part="snippet,cdn,contentDetails,status",
            body=dict(
                snippet=dict(
                    title=title,
                    description=description or "",
                ),
                cdn=dict(
                    frameRate="60fps",
                    ingestionType="rtmp",
                    resolution="1080p",
                ),
                contentDetails=dict(
                    isReusable=reusable,
                ),
            ),
        )
        .execute()
    )
    return response["cdn"]["ingestionInfo"]["streamName"], response["id"]


def schedule_streams(
    n: int,
    start_date: str,
    start_time: str | List[str],
    title: str,
    *,
    description: Optional[str] = None,
    playlist_id: Optional[str] = None,
    thumbnail: Optional[str] = None,
    shared_stream_key: bool = True,
    auto_start: bool = True,
    auto_stop: bool = True,
    tz: str = "Asia/Jerusalem",
    cadence: Literal["daily", "weekly"] = "weekly",
    privacy: Literal["public", "private", "unlisted", "public-at-start"] = "unlisted",
) -> List[Dict[str, str]]:
    """Schedule live streams on a daily or weekly cadence.

    Args:
        n: Number of days or weeks to schedule. Each period gets every start_time.
        start_date: Start date in %d-%m-%Y format (day-month-year).
        start_time: One or more times in %H:%M (24h) in the specified timezone.
        title: The title or title template.
        description: Optional description for each stream/broadcast.
        playlist_id: Optional playlist ID to insert each scheduled broadcast into.
        thumbnail: Optional PNG or JPEG path to apply to every scheduled broadcast.
        shared_stream_key: Reuse one stream key for every broadcast (default: True).
        auto_start: Whether to enable AutoStart on the broadcast (default: True).
        auto_stop: Whether to enable AutoStop on the broadcast (default: True).
        tz: IANA timezone name for scheduling (default: Asia/Jerusalem).
        cadence: How often to repeat the group of start times: daily or weekly.
        privacy: Broadcast visibility: public, private, unlisted, or public-at-start.

    Returns:
        A list of dicts with keys: scheduled_time, stream_key, broadcast_id, stream_id, playlist_item_id (optional).
    """
    try:
        zone = ZoneInfo(tz)
    except Exception as e:
        raise ValueError(
            f"Invalid timezone '{tz}'. Use a valid IANA name like 'Asia/Jerusalem' or 'UTC'."
        ) from e

    start_times = [start_time] if isinstance(start_time, str) else start_time
    scheduled_datetimes = _scheduled_datetimes(n, start_date, start_times, cadence, zone)
    scheduled_sessions = [
        (
            scheduled_local,
            _format_stream_title(title, scheduled_local, session_number),
        )
        for session_number, scheduled_local in enumerate(scheduled_datetimes, start=1)
    ]
    thumbnail_upload = _validate_thumbnail(thumbnail)
    youtube = get_authenticated_service()

    shared_stream = None
    if shared_stream_key:
        first_title = scheduled_sessions[0][1]
        shared_stream = _create_live_stream(
            youtube,
            first_title,
            description,
            reusable=True,
        )

    results: List[Dict[str, str]] = []

    for scheduled_local, stream_title in scheduled_sessions:
        # Convert local scheduled time to UTC RFC3339 for the API
        scheduled_start_time = _isoformat_utc(scheduled_local.astimezone(timezone.utc))

        # 1) Reuse the shared stream, or create a non-reusable stream for this broadcast.
        if shared_stream:
            new_stream_key, stream_id = shared_stream
        else:
            new_stream_key, stream_id = _create_live_stream(
                youtube,
                stream_title,
                description,
                reusable=False,
            )

        # 2) Create the live broadcast
        # Build status for broadcast insert. If using public-at-start, we insert as private first.
        insert_privacy = "private" if privacy == "public-at-start" else privacy
        broadcast_insert_response = (
            youtube.liveBroadcasts()
            .insert(
                part="snippet,status,contentDetails",
                body=dict(
                    snippet=dict(
                        title=stream_title,
                        description=description or "",
                        scheduledStartTime=scheduled_start_time,
                    ),
                    status=dict(
                        privacyStatus=insert_privacy,
                    ),
                    contentDetails=dict(
                        enableAutoStart=bool(auto_start),
                        enableAutoStop=bool(auto_stop),
                        enableDvr=True,
                    ),
                ),
            )
            .execute()
        )

        broadcast_id = broadcast_insert_response["id"]

        # If requested, schedule the video to automatically go public at the start time.
        if privacy == "public-at-start":
            youtube.videos().update(
                part="status",
                body=dict(
                    id=broadcast_id,
                    status=dict(
                        privacyStatus="private",
                        publishAt=scheduled_start_time,
                    ),
                ),
            ).execute()

        # 3) Bind the broadcast to the stream
        youtube.liveBroadcasts().bind(
            part="id,snippet,contentDetails,status",
            id=broadcast_id,
            streamId=stream_id,
        ).execute()

        # 4) Optionally upload the same custom thumbnail for every broadcast.
        if thumbnail_upload:
            thumbnail_path, thumbnail_mime_type = thumbnail_upload
            youtube.thumbnails().set(
                videoId=broadcast_id,
                media_body=MediaFileUpload(
                    str(thumbnail_path),
                    mimetype=thumbnail_mime_type,
                    resumable=False,
                ),
            ).execute()

        playlist_item_id = None
        # 5) Optionally insert the broadcast into a playlist
        if playlist_id:
            playlist_item_response = (
                youtube.playlistItems()
                .insert(
                    part="snippet",
                    body=dict(
                        snippet=dict(
                            playlistId=playlist_id,
                            resourceId=dict(
                                kind="youtube#video",
                                videoId=broadcast_id,
                            ),
                        )
                    ),
                )
                .execute()
            )
            playlist_item_id = playlist_item_response.get("id")

        results.append(
            {
                "scheduled_time": scheduled_start_time,
                "stream_key": new_stream_key,
                "broadcast_id": broadcast_id,
                "stream_id": stream_id,
                **({"playlist_item_id": playlist_item_id} if playlist_item_id else {}),
            }
        )

    # Print a concise report
    for r in results:
        # Convert the scheduled UTC time back to the configured local timezone for display
        try:
            dt_utc = datetime.fromisoformat(r["scheduled_time"].replace("Z", "+00:00"))
            dt_local = dt_utc.astimezone(zone)
            date_str = dt_local.strftime("%d/%m/%Y %H:%M")
        except Exception:
            # Fallback to original string if parsing fails
            date_str = r["scheduled_time"]

        live_url = f"https://www.youtube.com/live/{r['broadcast_id']}"
        line = f"{date_str}: {live_url}  stream_key: {r['stream_key']}"
        print(line)

    return results


if __name__ == "__main__":
    auto_cli(schedule_streams, as_positional=False)
