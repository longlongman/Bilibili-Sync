import logging

logger = logging.getLogger(__name__)


def log_video_selection(user: str, url: str) -> None:
    """Log which user selected which shared playback URL."""
    logger.info("video_selected", extra={"actor": user, "url": url})
