#!/usr/bin/env python3
"""Regenerate test/assets/sample.pdf and big.pdf (needs soffice and gs).
Usage: python3 test/assets/make-pdfs.py   (from the repo root)"""
import os, shutil, subprocess, tempfile

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp()
shutil.copy(os.path.join(here, 'logo with space.png'), os.path.join(tmp, 'logo.png'))
LOREM = ('Darkmark renders PDF pages lazily. Only the pages near the viewport keep a canvas; '
         'the rest are empty placeholders sized from the page viewport. ') * 6

def page(css, body):
    return f'<html><head><meta charset="utf-8"><style>{css} body{{font-family:serif}}</style></head><body>{body}</body></html>'

def soffice(name, html):
    src = os.path.join(tmp, name + '.html')
    open(src, 'w').write(html)
    subprocess.run(['soffice', '--headless', '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', tmp, src],
                   check=True, capture_output=True)
    return os.path.join(tmp, name + '.pdf')

def gs(out, *inputs):
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-dPDFSETTINGS=/ebook',
                    f'-sOutputFile={out}', *inputs], check=True)

# sample.pdf: portrait pages with headings, text, an image and a link, then a landscape page
a = soffice('portrait', page('@page{size:A4 portrait;margin:2cm}',
    '<h1>Darkmark sample PDF</h1><p>The quick brown fox jumps over the lazy dog. ' + LOREM + '</p>'
    '<p>Visit <a href="https://example.com/">https://example.com/</a> for more.</p>'
    '<p><img src="logo.png" width="200" height="200"></p>'
    '<h2 style="page-break-before:always">Second page</h2><p>Searchable needle: zebracorn. ' + LOREM + '</p>'))
b = soffice('landscape', page('@page{size:A4 landscape;margin:2cm}',
    '<h1>Landscape page</h1><p>This page is wider than it is tall. Another zebracorn lives here.</p>'))
gs(os.path.join(here, 'sample.pdf'), a, b)

# big.pdf: 100 pages of text, an image every 10 pages
body = ''
for i in range(1, 101):
    brk = ' style="page-break-before:always"' if i > 1 else ''
    img = '<p><img src="logo.png" width="160" height="160"></p>' if i % 10 == 0 else ''
    body += f'<h1{brk}>Page {i}</h1><p>Marker word page{i}marker. ' + (LOREM * 2) + f'</p>{img}'
gs(os.path.join(here, 'big.pdf'), soffice('big', page('@page{size:A4;margin:2cm}', body)))
shutil.rmtree(tmp)
