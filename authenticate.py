"""Authenticate this installation with a YouTube channel.

This performs a read-only API request after OAuth so the selected channel can
be verified without creating broadcasts or streams.
"""

from schedule import get_authenticated_service


def main() -> None:
    print("Opening Google authentication in your browser...")
    youtube = get_authenticated_service()
    response = youtube.channels().list(part="snippet", mine=True).execute()
    channels = response.get("items", [])

    if not channels:
        raise SystemExit(
            "Authentication succeeded, but no YouTube channel was found for "
            "the selected Google account."
        )

    print("\nConnected YouTube channel:")
    for channel in channels:
        print(f"  {channel['snippet']['title']} ({channel['id']})")
    print("\nCredentials saved locally in token.pickle.")


if __name__ == "__main__":
    main()
