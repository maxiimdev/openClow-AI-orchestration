#!/usr/bin/env python3
import argparse
import json


def classify(items):
    critical = sum(1 for x in items if x.get('severity') == 'critical')
    major = sum(1 for x in items if x.get('severity') == 'major')
    minor = sum(1 for x in items if x.get('severity') == 'minor')
    return critical, major, minor


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='Path to review findings JSON array')
    args = ap.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        findings = json.load(f)

    critical, major, minor = classify(findings)

    if critical > 0 or major > 0:
        status = 'needs_fixes'
    else:
        status = 'ready_for_human_review'

    out = {
        'status': status,
        'counts': {
            'critical': critical,
            'major': major,
            'minor': minor
        },
        'human_gate_required': True,
        'auto_merge_allowed': False
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
