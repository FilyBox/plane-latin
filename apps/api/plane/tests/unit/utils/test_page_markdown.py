# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A page read as Markdown and written back: what Markdown holds round-trips,
what it can't (images, checklists, colored text) comes back untouched."""

import pytest

from plane.utils.page_markdown import PageChanged, fingerprint, markdown_to_page_html, page_to_markdown

TRACK = "0b92bd6c-7c40-416a-9728-3a4a39ce1398"
PAGE = (
    '<h1>Informe</h1><p class="editor-paragraph-block">Hola <strong>mundo</strong> con '
    f'<mention-component id="x" entity_name="music_track" entity_identifier="{TRACK}"></mention-component></p>'
    '<ul class="list-disc" data-tight="true"><li><p>uno</p></li><li><p>dos</p></li></ul>'
    '<image-component src="abc" width="100"></image-component>'
    '<ul data-type="taskList"><li data-checked="false"><p>tarea</p></li></ul>'
    '<p><span style="color: red">rojo</span></p>'
    '<table><tbody><tr><th colspan="1" rowspan="1"><p>A</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr>'
    '<tr><td colspan="1" rowspan="1"><p>1</p></td><td colspan="1" rowspan="1"><p>2</p></td></tr></tbody></table>'
)
LABELS = {("music_track", TRACK): "TE AMO"}


def allow(kind, identifier):
    return True


def test_reads_supported_blocks_and_marks_the_rest():
    markdown, kept = page_to_markdown(PAGE, LABELS)
    assert markdown.startswith("# Informe\n\nHola **mundo** con :music_track[TE AMO]{name=" + TRACK + "}")
    assert "- uno\n- dos" in markdown
    assert "| A | B |\n|---|---|\n| 1 | 2 |" in markdown
    assert kept == 3
    assert markdown.count("[[bloque:") == 3


def test_writes_back_with_the_kept_blocks_untouched():
    markdown, _ = page_to_markdown(PAGE, LABELS)
    edited = markdown.replace("Hola **mundo**", "Adiós **mundo**") + "\n\nNuevo párrafo"
    html = markdown_to_page_html(edited, PAGE, {"music_track"}, allow)
    assert "Adiós <strong>mundo</strong>" in html
    assert f'entity_identifier="{TRACK}"' in html
    assert '<image-component src="abc" width="100"></image-component>' in html
    assert 'data-type="taskList"' in html
    assert '<span style="color: red">rojo</span>' in html
    assert html.endswith("<p>Nuevo párrafo</p>")


def test_dropping_a_marker_removes_its_block_and_a_vanished_one_is_refused():
    markdown, _ = page_to_markdown(PAGE, LABELS)
    first_marker = next(line for line in markdown.split("\n") if line.startswith("[[bloque:"))
    html = markdown_to_page_html(markdown.replace(first_marker, ""), PAGE, {"music_track"}, allow)
    assert "image-component" not in html
    with pytest.raises(PageChanged):
        markdown_to_page_html("[[bloque:0123456789]]", PAGE, set(), allow)


def test_fingerprint_follows_the_words():
    assert fingerprint("<p>hola</p>") == fingerprint("<p class='x'>hola</p>")
    assert fingerprint("<p>hola</p>") != fingerprint("<p>adiós</p>")
