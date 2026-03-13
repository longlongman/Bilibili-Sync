import time

from sync.state import PlaybackState


def test_play_sets_status_and_position():
    state = PlaybackState()
    snapshot = state.apply("play", 1200, actor="a1")
    assert snapshot["status"] == "playing"
    assert snapshot["position_ms"] == 1200
    assert snapshot["actor"] == "a1"


def test_seek_clamps_to_zero():
    state = PlaybackState(position_ms=100)
    snapshot = state.apply("seek", -50, actor="a2")
    assert snapshot["position_ms"] == 0
    assert snapshot["status"] == "paused" or snapshot["status"] == "playing"


def test_snapshot_advances_position_while_playing():
    state = PlaybackState()
    state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx")
    state.apply("play", 1000, actor="a1")

    time.sleep(0.02)

    snapshot = state.snapshot()
    assert snapshot["position_ms"] > 1000
    assert snapshot["state_at"]
    assert isinstance(snapshot["state_at_ms"], int)


def test_apply_ignores_client_reported_time():
    state = PlaybackState()
    snapshot = state.apply(
        "play",
        1200,
        actor="a1",
        reported_at="1999-01-01T00:00:00Z",
    )
    assert snapshot["state_at"] != "1999-01-01T00:00:00Z"
