from sync.state import PlaybackState


def test_play_sets_status_and_position():
    state = PlaybackState()
    state.set_video("https://player.bilibili.com/player.html?bvid=BV1xx", event_server_ms=1000)
    snapshot = state.apply("play", 1200, actor="a1", event_server_ms=1500)
    assert snapshot["status"] == "playing"
    assert snapshot["position_ms"] == 1200
    assert snapshot["actor"] == "a1"
    assert snapshot["server_state_at_ms"] == 1500
    assert snapshot["revision"] == 2


def test_seek_clamps_to_zero():
    state = PlaybackState(position_ms=100)
    state.set_video("https://player.bilibili.com/player.html?bvid=BV1yy", event_server_ms=1000)
    snapshot = state.apply("seek", -50, actor="a2", event_server_ms=2000)
    assert snapshot["position_ms"] == 0
    assert snapshot["status"] == "paused" or snapshot["status"] == "playing"


def test_position_at_projects_playing_state_on_server_timeline():
    state = PlaybackState()
    state.set_video("https://player.bilibili.com/player.html?bvid=BV1zz", event_server_ms=1000)
    state.apply("play", 3000, actor="a3", event_server_ms=2000)
    assert state.position_at(2600) == 3600
