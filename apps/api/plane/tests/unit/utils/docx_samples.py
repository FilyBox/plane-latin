# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""A .docx built by hand that puts together what makes Word hard to edit."""

from io import BytesIO
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NAMESPACES = (
    f'xmlns:w="{W}" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:v="urn:schemas-microsoft-com:vml" '
    'mc:Ignorable="w14"'
)
BOLD = "<w:rPr><w:b/><w:sz w:val='24'/></w:rPr>"
PLAIN = "<w:rPr><w:rFonts w:ascii='Arial'/><w:sz w:val='22'/></w:rPr>"


def run(text, props=PLAIN):
    space = ' xml:space="preserve"' if text != text.strip() else ""
    return f"<w:r>{props}<w:t{space}>{text}</w:t></w:r>"


def paragraph(content, props="", para_id=""):
    pid = f' w14:paraId="{para_id}" w14:textId="77777777"' if para_id else ""
    return f"<w:p{pid}>{props}{content}</w:p>"


NUMBERED = (
    "<w:pPr><w:pStyle w:val='Clausula'/>"
    "<w:numPr><w:ilvl w:val='0'/><w:numId w:val='1'/></w:numPr><w:jc w:val='both'/></w:pPr>"
)


def textbox(text):
    inner = paragraph(run(text))
    return (
        "<w:r><mc:AlternateContent>"
        "<mc:Choice Requires='wps'><w:drawing><wp:anchor><a:graphic><a:graphicData>"
        f"<wps:wsp><wps:txbx><w:txbxContent>{inner}</w:txbxContent></wps:txbx></wps:wsp>"
        "</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>"
        f"<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>{inner}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>"
        "</mc:AlternateContent></w:r>"
    )


def document_xml():
    body = "".join(
        [
            # 0: literal capitals in bold
            paragraph(run("CONTRATO DE EDICIÓN", BOLD), para_id="00000001"),
            # 1: the name split over three runs, one of them bold, with a proofing mark
            paragraph(
                run("que celebra el C. ")
                + run("Ju")
                + "<w:proofErr w:type='spellStart'/>"
                + run("an Pé", BOLD)
                + run("rez")
                + "<w:proofErr w:type='spellEnd'/>"
                + run(" en su carácter de ARTISTA"),
                para_id="00000002",
            ),
            # 2-3: automatic numbering
            paragraph(run("Duración: 3 años"), NUMBERED, para_id="00000003"),
            paragraph(run("Territorio: México"), NUMBERED, para_id="00000004"),
            # 4: a tab inside the paragraph
            paragraph(run("Firma") + "<w:r><w:tab/></w:r>" + run("Fecha")),
            # 5: a bookmark and a hyperlink
            paragraph(
                "<w:bookmarkStart w:id='0' w:name='exclusividad'/>"
                + run("Cláusula de exclusividad ")
                + "<w:bookmarkEnd w:id='0'/>"
                + "<w:hyperlink r:id='rIdLink'>"
                + run("ver anexo")
                + "</w:hyperlink>"
            ),
            # 6: a date field
            paragraph(
                run("Fecha: ")
                + "<w:r><w:fldChar w:fldCharType='begin'/></w:r>"
                + "<w:r><w:instrText xml:space='preserve'> DATE </w:instrText></w:r>"
                + "<w:r><w:fldChar w:fldCharType='separate'/></w:r>"
                + run("25/10/2026")
                + "<w:r><w:fldChar w:fldCharType='end'/></w:r>"
            ),
            # 7: tracked changes
            paragraph(
                run("Antes ")
                + "<w:ins w:id='1' w:author='Ana'>"
                + run("texto insertado")
                + "</w:ins>"
                + "<w:del w:id='2' w:author='Ana'><w:r><w:delText>borrado</w:delText></w:r></w:del>"
                + run(" después")
            ),
            # 8: a footnote reference
            paragraph(run("Regalías") + "<w:r><w:footnoteReference w:id='1'/></w:r>" + run(" del 15 %")),
            # 9: an image
            paragraph("<w:r><w:drawing><wp:inline/></w:drawing></w:r>"),
            # 10: a content control
            paragraph(
                "<w:sdt><w:sdtPr><w:alias w:val='Artista'/></w:sdtPr><w:sdtContent>"
                + run("Juan Pérez")
                + "</w:sdtContent></w:sdt>"
            ),
            # 11: a text box (written twice by Word)
            paragraph(run("Caja: ") + textbox("Juan Pérez en la caja")),
            # 12: a section break
            paragraph(
                run("Fin de la sección"), "<w:pPr><w:sectPr><w:pgSz w:w='12240' w:h='15840'/></w:sectPr></w:pPr>"
            ),
            # a table
            "<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/>" + paragraph(run("Juan Pérez en tabla")) + "</w:tc></w:tr></w:tbl>",
            paragraph(run("Firma del artista")),
            "<w:sectPr><w:pgSz w:w='12240' w:h='15840'/><w:pgMar w:top='1440'/></w:sectPr>",
        ]
    )
    declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    return f"{declaration}<w:document {NAMESPACES}><w:body>{body}</w:body></w:document>"


def part(root, content):
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:{root} {NAMESPACES}>{content}</w:{root}>'


NUMBERING = part(
    "numbering",
    "<w:abstractNum w:abstractNumId='0'><w:lvl w:ilvl='0'><w:start w:val='1'/><w:numFmt w:val='decimal'/>"
    "<w:lvlText w:val='Cláusula %1.'/></w:lvl></w:abstractNum><w:num w:numId='1'><w:abstractNumId w:val='0'/></w:num>",
)
STYLES = part("styles", "<w:style w:type='paragraph' w:styleId='Clausula'><w:name w:val='Clausula'/></w:style>")
SETTINGS = part("settings", "<w:trackRevisions/>")
HEADER = part("hdr", paragraph(run("JUAN PÉREZ", BOLD)))
FOOTNOTES = part(
    "footnotes",
    "<w:footnote w:type='separator' w:id='-1'><w:p><w:r><w:separator/></w:r></w:p></w:footnote>"
    f"<w:footnote w:id='1'>{paragraph(run('Nota sobre Juan Pérez'))}</w:footnote>",
)
IMAGE = bytes(range(256)) * 4


def build_docx():
    entries = [
        ("[Content_Types].xml", "<Types/>", ZIP_DEFLATED),
        ("_rels/.rels", "<Relationships/>", ZIP_DEFLATED),
        ("word/document.xml", document_xml(), ZIP_DEFLATED),
        ("word/header1.xml", HEADER, ZIP_DEFLATED),
        ("word/footnotes.xml", FOOTNOTES, ZIP_DEFLATED),
        ("word/numbering.xml", NUMBERING, ZIP_DEFLATED),
        ("word/styles.xml", STYLES, ZIP_DEFLATED),
        ("word/settings.xml", SETTINGS, ZIP_DEFLATED),
        ("word/media/image1.png", IMAGE, ZIP_STORED),
        (
            "docProps/core.xml",
            "<cp:coreProperties xmlns:cp='urn:core'><cp:creator>Ana</cp:creator></cp:coreProperties>",
            ZIP_DEFLATED,
        ),
    ]
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        for name, content, compression in entries:
            info = ZipInfo(name, date_time=(2024, 5, 1, 10, 30, 0))
            info.compress_type = compression
            archive.writestr(info, content.encode("utf-8") if isinstance(content, str) else content)
    return output.getvalue()


def simple_docx(paragraphs):
    """A plain document: one paragraph per text."""
    body = "".join(paragraph(run(text)) for text in paragraphs) + "<w:sectPr/>"
    declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    xml = f"{declaration}<w:document {NAMESPACES}><w:body>{body}</w:body></w:document>"
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
    return output.getvalue()
