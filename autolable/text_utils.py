"""Text cleaning and comparison normalization.

Ported from the C# CleanFormatSymbols logic in:
- D:\\C#code\\ConsoleApp2\\ConsoleApp2\\Program.cs (V6)
- D:\\C#code\\ConsoleApp1\\ConsoleApp1\\Program.cs (VL)
The two C# versions strip slightly different symbol sets; here we strip their union.
"""

_STRIP_CHARS = ("\\", "(", ")", "{", "}", "_")


def clean_text(s: str) -> str:
    """Strip formatting symbols and trim. Used for the stored/displayed text."""
    if not s:
        return ""
    for ch in _STRIP_CHARS:
        s = s.replace(ch, "")
    return s.strip()


def normalize_for_compare(s: str) -> str:
    """Aggressive normalization for equality comparison: clean, drop spaces, lowercase.

    Mirrors the C# comparison: cleanRecognized.Replace(" ", "") vs label, ignore case.
    """
    return clean_text(s).replace(" ", "").lower()
