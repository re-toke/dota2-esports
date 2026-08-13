#!/usr/bin/env python3
"""行高 Token 迁移（v17）：仅迁移无单位倍数，rpx 固定行距和 line-height:1 不动。"""
import re
import sys
from pathlib import Path

# 无单位小数映射
MAP = {
    '1.2': '--lh-tight',
    '1.25': '--lh-tight',
    '1.3': '--lh-tight',
    '1.35': '--lh-normal',
    '1.4': '--lh-normal',
    '1.45': '--lh-normal',
    '1.5': '--lh-relaxed',
    '1.55': '--lh-relaxed',
    '1.6': '--lh-relaxed',
    '1.65': '--lh-loose',
    '1.7': '--lh-loose',
    '1.75': '--lh-loose',
    '1.8': '--lh-loose',
}

PATTERN = re.compile(r'line-height:\s*(1\.\d+)')

def main():
    dry_run = '--dry-run' in sys.argv
    root = Path(__file__).parent.parent
    skip = ['node_modules', 'miniprogram_npm']
    total = 0
    for f in sorted(root.rglob('*.wxss')):
        if any(s in str(f) for s in skip):
            continue
        try:
            content = f.read_text(encoding='utf-8')
        except:
            continue
        count = [0]
        def repl(m):
            v = m.group(1)
            if v in MAP:
                count[0] += 1
                return f'line-height: var({MAP[v]})'
            return m.group(0)
        new = PATTERN.sub(repl, content)
        if count[0] > 0 and not dry_run:
            f.write_text(new, encoding='utf-8')
        total += count[0]
        if count[0] > 0:
            print(f'  {f.relative_to(root)}: {count[0]} 处')
    print(f'\n总替换: {total}{"（DRY RUN）" if dry_run else ""}')

if __name__ == '__main__':
    main()
