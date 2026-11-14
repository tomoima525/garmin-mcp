from garmin_mcp.compact import compact, dig


def test_drops_nulls_and_empties() -> None:
    assert compact({"a": None, "b": [], "c": {}, "d": "", "e": 0, "f": {"g": None}}) == {"e": 0}


def test_truncates_long_lists_only_when_asked() -> None:
    data = {"series": list(range(100)), "short": [1, 2]}
    out = compact(data, max_list=50)
    assert out["short"] == [1, 2]
    assert out["series"].startswith("<100 items omitted")
    assert compact(data, max_list=None)["series"] == list(range(100))


def test_dig() -> None:
    d = {"a": {"b": [{"c": 1}]}, "n": None}
    assert dig(d, "a", "b", 0, "c") == 1
    assert dig(d, "a", "x", default="z") == "z"
    assert dig(d, "n", "anything") is None
