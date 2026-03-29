#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path

DOC_ROOTS = [
    Path('/root/.openclaw/workspace/docs'),
    Path('/root/.openclaw/workspace'),
]
INCLUDE_NAMES = {
    'project_overview.md','architecture.md','style_guide.md','business_rules.md','api_notes.md',
    'known_bugs_and_postmortems.md','qa_checklist.md','qa_guardrails.md','flow.md','agents.md',
    'token_policy.md','decisions_log.md','system_overview.md'
}

def iter_md_files():
    seen = set()
    for root in DOC_ROOTS:
        if not root.exists():
            continue
        for p in root.rglob('*.md'):
            lp = p.name.lower()
            if lp in INCLUDE_NAMES or 'ai-orchestration' in str(p).lower():
                rp = str(p.resolve())
                if rp not in seen:
                    seen.add(rp)
                    yield p

def score(text, terms):
    t = text.lower()
    return sum(t.count(term) for term in terms)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('query')
    ap.add_argument('--top', type=int, default=5)
    args = ap.parse_args()

    terms = [x for x in re.split(r'\W+', args.query.lower()) if len(x) > 2]
    hits = []
    for p in iter_md_files():
        try:
            content = p.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            continue
        lines = content.splitlines()
        for i, line in enumerate(lines, start=1):
            s = score(line, terms)
            if s > 0:
                snippet = line.strip()
                if not snippet:
                    continue
                hits.append({
                    'path': str(p),
                    'line': i,
                    'score': s,
                    'snippet': snippet[:300]
                })

    hits.sort(key=lambda x: x['score'], reverse=True)
    out = {
        'query': args.query,
        'count': min(len(hits), args.top),
        'results': hits[:args.top]
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
