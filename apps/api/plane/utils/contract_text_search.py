# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Literal term matching inside contract text, for the chat agents.

Three things plain `folded.find(term)` got wrong on a few hundred contracts:

- Short acronyms matched inside words: "INE" hit "línea", "cine" and
  "determinen", so nearly every contract "mentioned the INE".
- The official ID has several names. A contract from 2017 usually says
  "IFE" or "credencial para votar", not "INE".
- "José's INE" means the name and the ID close together, not each somewhere
  in a 40-page document.
"""

import re
import unicodedata

# Every name a Mexican voter ID goes by. Asking for any of them finds all.
# INE replaced IFE in 2014, and IFE credentials stayed valid for years after.
ID_CARD_VARIANTS = (
    "ine",
    "ife",
    "credencial para votar",
    "credencial de elector",
    "credencial electoral",
    "instituto nacional electoral",
    "instituto federal electoral",
)
SYNONYM_GROUPS = (ID_CARD_VARIANTS,)

# Terms this short (or written as an acronym) only count as whole words.
WHOLE_WORD_MAX_CHARS = 4
ACRONYM_MAX_CHARS = 6
OCCURRENCES_PER_TERM = 300
NON_ASCII = re.compile(r"[^\x00-\x7f]")
BOUNDARY_BEFORE = r"(?<![a-z0-9])"
BOUNDARY_AFTER = r"(?![a-z0-9])"


def fold(value):
    """Lowercase without accents ("José" -> "jose")."""
    return "".join(
        char for char in unicodedata.normalize("NFD", str(value)) if unicodedata.category(char) != "Mn"
    ).lower()


def fold_aligned(text):
    """`fold`, but one output character per input character, so a position
    found in the folded text points at the same place in the original."""
    lowered = text.lower()
    if len(lowered) == len(text):
        # Fast path: only the few non-ASCII characters need folding
        table = {}
        for char in set(NON_ASCII.findall(lowered)):
            folded = fold(char)
            table[char] = folded if len(folded) == 1 else " "
        return NON_ASCII.sub(lambda match: table[match.group()], lowered) if table else lowered
    # A character whose lowercase is longer ("İ"): fold one by one
    table = {}
    for char in set(text):
        folded = fold(char)
        if len(folded) != 1:
            lowered_char = char.lower()
            folded = lowered_char if len(lowered_char) == 1 else " "
        if folded != char:
            table[ord(char)] = folded
    return text.translate(table)


def _is_acronym(keyword):
    letters = keyword.replace(".", "")
    return letters.isalpha() and letters.isupper() and 2 <= len(letters) <= ACRONYM_MAX_CHARS


def _body(variant, whole_word):
    words = variant.split()
    if len(words) == 1 and whole_word and variant.isalpha():
        # "I.N.E." and "INE" alike
        return r"\.?".join(re.escape(letter) for letter in variant) + r"\.?"
    # A line break or double space between words still matches
    return r"\s+".join(re.escape(word) for word in words)


class Term:
    """One keyword the user asked for, with every spelling that counts as it."""

    def __init__(self, keyword):
        self.keyword = keyword
        needle = fold(keyword).strip()
        variants = [needle]
        for group in SYNONYM_GROUPS:
            if needle in group:
                variants = list(group)
                break
        self.variants = variants
        whole, partial = [], []
        for variant in variants:
            compact = variant.replace(" ", "").replace(".", "")
            whole_word = len(compact) <= WHOLE_WORD_MAX_CHARS or (variant == needle and _is_acronym(keyword))
            (whole if whole_word else partial).append(_body(variant, whole_word))
        patterns = list(partial)
        if whole:
            patterns.append(BOUNDARY_BEFORE + "(?:" + "|".join(whole) + ")" + BOUNDARY_AFTER)
        self.regex = re.compile("|".join(f"(?:{pattern})" for pattern in patterns)) if needle else None

    @property
    def expanded(self):
        return len(self.variants) > 1

    def occurrences(self, folded, limit=OCCURRENCES_PER_TERM):
        """(start, end) of each match in `folded` (from `fold_aligned`)."""
        if self.regex is None:
            return []
        found = []
        for match in self.regex.finditer(folded):
            found.append((match.start(), match.end()))
            if len(found) >= limit:
                break
        return found


def terms_for(keywords):
    return [term for term in (Term(keyword) for keyword in keywords) if term.regex is not None]


def closest_cluster(occurrences):
    """Smallest span holding one occurrence of every term.

    `occurrences` is a list (one entry per term) of (start, end) lists.
    Returns (start, end) or None when some term never occurs.
    """
    if not occurrences or any(not hits for hits in occurrences):
        return None
    points = sorted((start, end, index) for index, hits in enumerate(occurrences) for start, end in hits)
    needed = len(occurrences)
    counts = [0] * needed
    covered = 0
    best = None
    left = 0
    for right, (_, _, index) in enumerate(points):
        if counts[index] == 0:
            covered += 1
        counts[index] += 1
        while covered == needed:
            start = points[left][0]
            # Terms are short, so the window ends with the rightmost hit
            end = max(points[right][1], points[left][1])
            if best is None or end - start < best[1] - best[0]:
                best = (start, end)
            left_index = points[left][2]
            counts[left_index] -= 1
            if counts[left_index] == 0:
                covered -= 1
            left += 1
    return best


def window(text, start, end, size):
    """The original text around [start, end), whitespace collapsed."""
    pad = max(0, size - (end - start)) // 2
    left = max(0, start - pad)
    right = min(len(text), end + pad)
    return " ".join(text[left:right].split())
