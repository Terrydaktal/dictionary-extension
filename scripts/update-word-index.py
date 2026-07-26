#!/usr/bin/env python3
"""Build the compact DictAI word-membership index used by the extension."""

from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT / "shared" / "word-index.bin"
META_PATH = ROOT / "shared" / "word-index.meta.json"
SITEMAP_URL = "https://www.dictai.org/sitemap.xml"
LOC_RE = re.compile(rb"<loc>\s*([^<]+?)\s*</loc>", re.IGNORECASE)
WORD_PATH_RE = re.compile(r"https://www\.dictai\.org/w/([^?#]+)$", re.IGNORECASE)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
            "User-Agent": "DictAI-Dictionary-Extension-Index-Updater/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def locations(xml: bytes) -> list[str]:
    return [
        match.group(1).decode("utf-8", errors="strict").replace("&amp;", "&")
        for match in LOC_RE.finditer(xml)
    ]


def fnv1a_64(value: str) -> int:
    result = 0xCBF29CE484222325
    for byte in value.encode("utf-8"):
        result ^= byte
        result = (result * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return result


def main() -> int:
    print(f"Fetching sitemap index: {SITEMAP_URL}")
    sitemap_index = fetch(SITEMAP_URL)
    sitemap_urls = [
        url
        for url in locations(sitemap_index)
        if re.search(r"/sitemap-\d+\.xml$", url)
    ]
    if not sitemap_urls:
        raise RuntimeError("DictAI sitemap index did not contain word sitemap shards")

    words: set[str] = set()
    for index, sitemap_url in enumerate(sitemap_urls, start=1):
        print(f"[{index}/{len(sitemap_urls)}] {sitemap_url}")
        for location in locations(fetch(sitemap_url)):
            match = WORD_PATH_RE.fullmatch(location)
            if not match:
                continue
            word = urllib.parse.unquote(match.group(1)).strip().lower()
            if word:
                words.add(word)

    hashes = sorted({fnv1a_64(word) for word in words})
    payload = b"".join(struct.pack("<Q", value) for value in hashes)
    OUTPUT_PATH.write_bytes(payload)

    metadata = {
        "source": SITEMAP_URL,
        "generatedAt": datetime.now(UTC).isoformat(),
        "wordCount": len(words),
        "hashCount": len(hashes),
        "hash": "fnv1a-64-le",
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }
    META_PATH.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(hashes):,} hashes ({len(payload):,} bytes) "
        f"to {OUTPUT_PATH.relative_to(ROOT)}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
