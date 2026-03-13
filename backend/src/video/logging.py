import logging

logger = logging.getLogger(__name__)


def log_video_selection(user: str, url: str) -> None:
    logger.info("video_selected", extra={"actor": user, "url": url})
