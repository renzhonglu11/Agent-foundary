from pathlib import Path
import sys
import os

try:
    import pymupdf
except ModuleNotFoundError:
    import fitz as pymupdf

ROOT = Path(os.environ.get("AGENT_FOUNDRY_ROOT", Path(__file__).resolve().parents[4]))
PDF = ROOT / 'data' / 'Vermögensübersicht.pdf'
OUT = ROOT / 'data' / 'asset_overview_extracted.txt'

def main():
    pdf = Path(sys.argv[1]) if len(sys.argv) > 1 else PDF
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else OUT

    doc = pymupdf.open(pdf)
    text = '\n'.join(page.get_text('text') for page in doc)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding='utf-8')
    print(f'Extracted {doc.page_count} page(s), {len(text)} chars -> {out}')

if __name__ == '__main__':
    main()
