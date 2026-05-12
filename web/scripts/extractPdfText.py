import pymupdf
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / 'data' / 'Vermögensübersicht.pdf'
OUT = ROOT / 'data' / 'asset_overview_extracted.txt'

def main():
    doc = pymupdf.open(PDF)
    text = '\n'.join(page.get_text('text') for page in doc)
    OUT.write_text(text, encoding='utf-8')
    print(f'Extracted {doc.page_count} page(s), {len(text)} chars -> {OUT}')

if __name__ == '__main__':
    main()
