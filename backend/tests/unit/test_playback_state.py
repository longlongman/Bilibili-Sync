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
