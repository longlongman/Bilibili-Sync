import re
from typing import Optional, Tuple
from urllib.parse import parse_qs, urlparse

BVID_PATTERN = re.compile(r"BV[0-9A-Za-z]{10}")


def extract_bvid(url: str) -> Optional[str]:
    parsed = urlparse(url)
    candidate: Optional[str] = None
    # Direct path BV
    match = BVID_PATTERN.search(parsed.path)
    if match:
        candidate = match.group(0)
    # Query parameter bvid
    if not candidate:
        qs = parse_qs(parsed.query)
        bvids = qs.get("bvid") or qs.get("bv")
        if bvids:
            candidate = bvids[0]
    return candidate


def normalize_bilibili_url(url: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """Return (valid, normalized_embed_url, error_message)."""
    if not url:
        return False, None, "Missing URL"
    bvid = extract_bvid(url)
    if not bvid:
        return False, None, "Unsupported or invalid Bilibili link"
    embed_url = f"https://player.bilibili.com/player.html?bvid={bvid}&autoplay=0"
    return True, embed_url, None
