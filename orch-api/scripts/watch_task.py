#!/usr/bin/env python3
import argparse, json, time, urllib.request


def get(url, token):
    req = urllib.request.Request(url)
    req.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode('utf-8'))


def main():
    ap = argparse.ArgumentParser(description='Watch task status/events from orch-api')
    ap.add_argument('--base-url', required=True)
    ap.add_argument('--token', required=True)
    ap.add_argument('--task-id', required=True)
    ap.add_argument('--interval', type=float, default=2.0)
    args = ap.parse_args()

    seen = 0
    done = {'completed', 'failed', 'timeout', 'rejected'}

    while True:
        data = get(f"{args.base_url}/api/task/{args.task_id}", args.token)
        task = data.get('task', {})
        events = task.get('events') or []
        if len(events) > seen:
            for e in events[seen:]:
                print(f"[{e.get('status')}/{e.get('phase')}] {e.get('message')}")
            seen = len(events)

        status = task.get('status')
        if status in done:
            print(f"FINAL: {status}")
            break
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
