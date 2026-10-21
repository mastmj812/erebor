"""app.novi_pads — which Novi pad vintage the overlay and the Accuracy frame
draw. The warehouse keeps '3Q25' (file-drop label) and '2026Q3' (share label)
polygons side by side; exactly one must be drawn, and the newest must win even
though '3Q25' > '2026Q3' as strings. DB-free."""

from __future__ import annotations

from app.novi_pads import newest_vintage, vintage_key


def test_vintage_key_reads_both_label_formats():
    assert vintage_key("3Q25") == (2025, 3)
    assert vintage_key("2026Q3") == (2026, 3)
    assert vintage_key("4Q26") == (2026, 4)
    assert vintage_key("Q3 2026") is None
    assert vintage_key("") is None


def test_newest_vintage_is_by_quarter_not_string_order():
    assert "3Q25" > "2026Q3"  # why string order is wrong
    assert newest_vintage(["3Q25", "2026Q3"]) == "2026Q3"
    assert newest_vintage(["2026Q3", "4Q26"]) == "4Q26"


def test_newest_vintage_only_3q25_and_empty():
    assert newest_vintage(["3Q25"]) == "3Q25"   # before the 2026Q3 load: unchanged behavior
    assert newest_vintage([]) is None           # no pads -> overlay empty, Accuracy radius frame
    assert newest_vintage(["garbage"]) is None
