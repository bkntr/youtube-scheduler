#!/usr/bin/env bash

# Legacy CLI examples. Replace dates and content with values appropriate for
# your own channel. Keep real playlist IDs and private titles out of Git.

uv run schedule.py --n 3 \
  --start_date 26-07-2026 \
  --start_time 20:00 \
  --title "Weekly session %d.%m.%y" \
  --privacy unlisted

uv run schedule.py --n 5 \
  --start_date 27-07-2026 \
  --start_time 09:00 \
  --title "Morning session {session} - %d.%m.%y" \
  --cadence daily \
  --privacy private
