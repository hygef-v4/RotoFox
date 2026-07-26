"""Tests for path resolution, identifier validation and cache retention."""

from __future__ import annotations

import pytest

from app.core.paths import safe_id, safe_suffix
from app.services.cache_manager import CacheManager


class TestSafeId:
    """`video_id` becomes a directory name, so traversal must be impossible."""

    @pytest.mark.parametrize("value", ["video_123", "abc-DEF_9", "a"])
    def test_accepts_plain_identifiers(self, value):
        assert safe_id(value) == value

    @pytest.mark.parametrize("value", [
        "../../etc",
        "../secrets",
        "video/../..",
        "a/b",
        "a\\b",
        "",
        "with space",
        "semi;colon",
        "x" * 65,
    ])
    def test_rejects_anything_that_could_escape_the_cache(self, value):
        with pytest.raises(ValueError):
            safe_id(value)

    def test_cache_manager_refuses_a_traversal_id(self):
        with pytest.raises(ValueError):
            CacheManager.get_video_dir("../../../tmp/pwned")


class TestSafeSuffix:
    ALLOWED = frozenset({".mp4", ".mov", ".webm"})

    def test_keeps_a_whitelisted_extension(self):
        assert safe_suffix("clip.MP4", self.ALLOWED) == ".mp4"

    def test_rejects_an_executable_extension(self):
        # A malicious upload named "../../startup/x.bat" must not be able to
        # place a .bat anywhere. Only the extension is ever read, and only when
        # it is on the allow-list.
        assert safe_suffix("../../startup/x.bat", self.ALLOWED) == ".mov"

    def test_handles_a_missing_extension(self):
        assert safe_suffix("noextension", self.ALLOWED) in self.ALLOWED

    def test_handles_an_empty_name(self):
        assert safe_suffix("", self.ALLOWED) in self.ALLOWED


class TestCacheRetention:
    def test_prune_keeps_the_most_recent_sessions(self):
        # Importing a new video used to wipe every previous session, so a user
        # could never return to an earlier clip's masks.
        for index in range(6):
            directory = CacheManager.get_video_dir(f"video_{1000 + index}")
            (directory / "00000.jpg").write_bytes(b"x")

        removed = CacheManager.prune_sessions(keep=3)

        assert removed == 3
        assert len(CacheManager.list_sessions()) == 3

    def test_prune_never_removes_the_excluded_session(self):
        for index in range(4):
            CacheManager.get_video_dir(f"video_{2000 + index}")

        CacheManager.prune_sessions(keep=1, exclude="video_2000")

        names = {p.name for p in CacheManager.list_sessions()}
        assert "video_2000" in names

    def test_clear_masks_keeps_extracted_frames(self):
        video_id = "video_3000"
        directory = CacheManager.get_video_dir(video_id)
        (directory / "00000.jpg").write_bytes(b"frame")
        (CacheManager.get_mask_dir(video_id) / "00000.png").write_bytes(b"mask")
        (CacheManager.get_alpha_dir(video_id) / "00000.png").write_bytes(b"alpha")

        CacheManager.clear_masks(video_id)

        assert (directory / "00000.jpg").exists(), "Frames must survive a mask reset"
        assert not (CacheManager.get_mask_dir(video_id) / "00000.png").exists()
        assert not (CacheManager.get_alpha_dir(video_id) / "00000.png").exists()
