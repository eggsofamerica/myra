#!/usr/bin/env python3
"""MyRA helper for the scheduled Claude check: download PSC documents and turn them into
page-marked text. Every command prints one JSON line. Needs curl and pdftotext (poppler-utils).

  fetch  URL OUT                         download one document
  filing OUT --urls U1 U2 ... [--titles "T1|T2"] [--start] [--pages "2:10-14"]
         download every document of a filing and write one text file with [d<k> p. N] markers.
         --start keeps only the opening of long documents (cover letter, first pages, contents,
         executive summary); --pages keeps only the listed pages of one document (doc:from-to,...).
  pdftext PDF OUT                         page-marked text of a local PDF
  transcript PDF OUT --find "26-G-0384|Item 164|Brooklyn Union"
         pages of a session transcript that mention any of the terms, with one page of context.
"""
import json, os, re, subprocess, sys, zipfile, argparse, html

UA = 'MyRA/1.0 (personal PSC tracker)'
LONG_PAGES = 40


def out(**kw):
    print(json.dumps(kw, ensure_ascii=False))


def fetch(url, path):
    last = ''
    for _ in range(3):
        r = subprocess.run(['curl', '-sS', '-L', '--max-time', '180', '-A', UA, '-o', path, '-w', '%{http_code} %{content_type}', url],
                           capture_output=True, text=True)
        code = (r.stdout or '').split(' ')[0]
        if r.returncode == 0 and code.startswith('2') and os.path.getsize(path) > 0:
            return (r.stdout.split(' ', 1) + [''])[1]
        last = (r.stderr or r.stdout or '').strip()[:200]
    raise RuntimeError('download failed: ' + last)


def kind_of(path, ctype=''):
    with open(path, 'rb') as f:
        head = f.read(8)
    if head.startswith(b'%PDF'):
        return 'pdf'
    if head.startswith(b'PK'):
        names = zipfile.ZipFile(path).namelist()
        if 'word/document.xml' in names:
            return 'docx'
        if any(n.startswith('xl/') for n in names):
            return 'xlsx'
        return 'zip'
    if 'html' in ctype or head.lstrip().startswith(b'<'):
        return 'html'
    return 'other'


def pdf_pages(path):
    r = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True)
    text = r.stdout.decode('utf-8', 'replace')
    pages = text.split('\f')
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def docx_pages(path):
    xml = zipfile.ZipFile(path).read('word/document.xml').decode('utf-8', 'replace')
    paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.S)
    lines = [html.unescape(''.join(re.findall(r'<w:t[^>]*>(.*?)</w:t>', p, re.S))) for p in paras]
    text = '\n'.join(lines)
    # No real pages in a .docx: cut every ~3,000 characters so page markers still help.
    return [text[i:i + 3000] for i in range(0, max(len(text), 1), 3000)]


def doc_pages(path, ctype=''):
    k = kind_of(path, ctype)
    if k == 'pdf':
        return k, pdf_pages(path)
    if k == 'docx':
        return k, docx_pages(path)
    if k == 'html':
        t = open(path, encoding='utf-8', errors='replace').read()
        t = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', t, flags=re.S)
        t = html.unescape(re.sub(r'<[^>]+>', ' ', t))
        return k, [re.sub(r'[ \t]+', ' ', t)]
    return k, []


START_RE = re.compile(r'table of contents|executive summary|summary of (the )?(order|filing|petition|proposal)|introduction', re.I)


def start_pages(pages):
    """Pages to read for a starting summary of a long document."""
    keep = set(range(min(6, len(pages))))
    for i, p in enumerate(pages[:30]):
        if START_RE.search(p[:1500]):
            keep.update(range(i, min(i + 4, len(pages))))
    return sorted(keep)[:20]


def parse_ranges(spec):
    rng = {}
    for part in (spec or '').split(','):
        m = re.match(r'\s*(\d+):(\d+)(?:-(\d+))?\s*$', part)
        if m:
            d, a, b = int(m.group(1)), int(m.group(2)), int(m.group(3) or m.group(2))
            rng.setdefault(d, set()).update(range(a, b + 1))
    return rng


def cmd_filing(a):
    titles = (a.titles or '').split('|') if a.titles else []
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    ranges = parse_ranges(a.pages)
    chunks, docs = [], []
    for k, url in enumerate(a.urls, 1):
        title = titles[k - 1] if k - 1 < len(titles) else ''
        path = os.path.splitext(a.out)[0] + '_d%d.bin' % k
        info = {'k': k, 'title': title}
        try:
            ctype = fetch(url, path)
            kind, pages = doc_pages(path, ctype)
            info.update(kind=kind, pages=len(pages))
            if not pages:
                info['note'] = 'not readable as text (%s)' % kind
                docs.append(info)
                continue
            if ranges:
                idx = sorted(i - 1 for i in ranges.get(k, set()) if 0 < i <= len(pages))
            elif a.start and len(pages) > LONG_PAGES:
                idx = start_pages(pages)
                info['partial'] = True
            else:
                idx = list(range(len(pages)))
            if not idx:
                docs.append(info)
                continue
            chunks.append('\n===== Document %d: %s (%d pages%s) =====\n' % (k, title or os.path.basename(url), len(pages), ', excerpt' if info.get('partial') or ranges else ''))
            for i in idx:
                chunks.append('[d%d p. %d]\n%s' % (k, i + 1, pages[i].strip()))
            info['kept'] = len(idx)
        except Exception as e:  # noqa
            info['error'] = str(e)[:200]
        docs.append(info)
    text = '\n'.join(chunks)
    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(text)
    ok = any('kept' in d for d in docs)
    out(ok=ok, out=a.out, chars=len(text), totalPages=sum(d.get('pages', 0) for d in docs),
        long=any(d.get('pages', 0) > LONG_PAGES for d in docs), docs=docs)


def cmd_fetch(a):
    try:
        ctype = fetch(a.url, a.out)
        kind, pages = doc_pages(a.out, ctype)
        out(ok=True, out=a.out, kind=kind, pages=len(pages), bytes=os.path.getsize(a.out))
    except Exception as e:  # noqa
        out(ok=False, error=str(e)[:300])


def cmd_pdftext(a):
    pages = pdf_pages(a.pdf)
    text = '\n'.join('[p. %d]\n%s' % (i + 1, p.strip()) for i, p in enumerate(pages))
    open(a.out, 'w', encoding='utf-8').write(text)
    out(ok=bool(pages), out=a.out, pages=len(pages), chars=len(text))


def cmd_transcript(a):
    pages = pdf_pages(a.pdf)
    terms = [t.strip() for t in (a.find or '').split('|') if t.strip()]
    pats = [re.compile(re.escape(t).replace(r'\ ', r'\s+'), re.I) for t in terms]
    hits, keep = {}, set()
    for i, p in enumerate(pages):
        found = [t for t, rx in zip(terms, pats) if rx.search(p)]
        if found:
            hits[i + 1] = found
            keep.update(range(max(0, i - 1), min(len(pages), i + 2)))
    idx = sorted(keep)
    text = '\n'.join('[p. %d]\n%s' % (i + 1, pages[i].strip()) for i in idx)
    open(a.out, 'w', encoding='utf-8').write(text)
    out(ok=bool(pages), out=a.out, pages=len(pages), kept=len(idx), chars=len(text),
        hits={str(k): v for k, v in sorted(hits.items())}, unmatched=[t for t in terms if not any(t in v for v in hits.values())])


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('fetch'); s.add_argument('url'); s.add_argument('out')
    s = sub.add_parser('filing'); s.add_argument('out'); s.add_argument('--urls', nargs='+', required=True)
    s.add_argument('--titles'); s.add_argument('--start', action='store_true'); s.add_argument('--pages')
    s = sub.add_parser('pdftext'); s.add_argument('pdf'); s.add_argument('out')
    s = sub.add_parser('transcript'); s.add_argument('pdf'); s.add_argument('out'); s.add_argument('--find', required=True)
    a = p.parse_args()
    try:
        {'fetch': cmd_fetch, 'filing': cmd_filing, 'pdftext': cmd_pdftext, 'transcript': cmd_transcript}[a.cmd](a)
    except Exception as e:  # noqa
        out(ok=False, error=str(e)[:300])


if __name__ == '__main__':
    main()
