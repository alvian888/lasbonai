#!/usr/bin/env python3
"""
Cleanup script: limit files in 'token portfolio/llist' to MAX_FILES.
Deletes the oldest files (by mtime) when count exceeds the limit.
Usage: python3 scripts/cleanup-llist.py [--dry-run] [--max 1440]
"""
import os
import sys
import argparse

FOLDER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      'token portfolio', 'llist')
DEFAULT_MAX = 1440


def main():
    parser = argparse.ArgumentParser(description='Cleanup llist folder')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would be deleted without actually deleting')
    parser.add_argument('--max', type=int, default=DEFAULT_MAX,
                        help=f'Max number of files to keep (default: {DEFAULT_MAX})')
    args = parser.parse_args()

    if not os.path.isdir(FOLDER):
        print(f"ERROR: folder not found: {FOLDER}")
        sys.exit(1)

    files = [
        os.path.join(FOLDER, f)
        for f in os.listdir(FOLDER)
        if os.path.isfile(os.path.join(FOLDER, f))
    ]

    total = len(files)
    print(f"Folder  : {FOLDER}")
    print(f"Files   : {total}")
    print(f"Max keep: {args.max}")

    if total <= args.max:
        print("OK — no cleanup needed.")
        return

    # Sort oldest first (smallest mtime)
    files.sort(key=lambda f: os.path.getmtime(f))

    to_delete = files[:total - args.max]
    print(f"To delete: {len(to_delete)} oldest file(s)")

    for path in to_delete:
        fname = os.path.basename(path)
        mtime = os.path.getmtime(path)
        import datetime
        mtime_str = datetime.datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M:%S')
        if args.dry_run:
            print(f"  [DRY-RUN] would delete: {fname}  (mtime {mtime_str})")
        else:
            os.remove(path)
            print(f"  deleted: {fname}  (mtime {mtime_str})")

    remaining = total - (0 if args.dry_run else len(to_delete))
    print(f"\nRemaining files: {remaining}")


if __name__ == '__main__':
    main()
