# -*- coding: utf-8 -*-
"""
圆角 Token 迁移脚本（v18）
将页面级硬编码 border-radius 替换为 var(--radius-*) Token。

映射表：
  4   -> --radius-xs
  8   -> --radius-sm
  12  -> --radius-md
  16  -> --radius-lg
  24  -> --radius-xl
  999 -> --radius-pill

规则：
- 单值/多值 border-radius 中所有可映射值 -> 替换
- 混有非阶梯值（6/10/14/18/20/28rpx 等微调值）-> 部分替换，非阶梯值保留
- calc()/var() 已有引用自动跳过
- 不处理 app.wxss（Token 定义处）
"""
import os
import re
import sys

MAPPING = {
    4: 'var(--radius-xs)',
    8: 'var(--radius-sm)',
    12: 'var(--radius-md)',
    16: 'var(--radius-lg)',
    24: 'var(--radius-xl)',
    999: 'var(--radius-pill)',
}

ATTR_RE = re.compile(r'(border-radius):\s*([^;}]+)')
VALUE_TOKEN_RE = re.compile(r'^(\d+)rpx$')


def migrate_file(path, dry_run=False):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    replaced = 0
    partial = 0
    changed = False
    new_lines = []
    for line in lines:
        new_line = line
        for m in reversed(list(ATTR_RE.finditer(line))):
            value = m.group(2)
            tokens = value.split()
            new_tokens = []
            any_rpx = False
            any_mapped = False
            any_unmapped_rpx = False
            for tok in tokens:
                tm = VALUE_TOKEN_RE.match(tok.strip())
                if tm:
                    any_rpx = True
                    n = int(tm.group(1))
                    if n in MAPPING:
                        any_mapped = True
                        new_tokens.append(MAPPING[n])
                    else:
                        any_unmapped_rpx = True
                        new_tokens.append(tok)
                else:
                    new_tokens.append(tok)
            if not any_rpx or not any_mapped:
                continue
            new_value = ' '.join(new_tokens)
            new_line = new_line[:m.start(2)] + new_value + new_line[m.end(2):]
            if any_unmapped_rpx:
                partial += 1
            else:
                replaced += 1
            changed = True
        new_lines.append(new_line)

    if not dry_run and changed:
        with open(path, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
    return replaced, partial


def main():
    dry_run = '--dry-run' in sys.argv
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = []
    for base in ('pages', 'subpackages', 'custom-tab-bar', 'components'):
        d = os.path.join(root, base)
        if not os.path.isdir(d):
            continue
        for dirpath, _, files in os.walk(d):
            for fn in files:
                if fn.endswith('.wxss'):
                    targets.append(os.path.join(dirpath, fn))

    total_replaced = 0
    total_partial = 0
    print(f'{"[DRY-RUN] " if dry_run else ""}圆角 Token 迁移')
    print('=' * 60)
    for t in sorted(targets):
        r, p = migrate_file(t, dry_run)
        if r > 0 or p > 0:
            print(f'  {os.path.relpath(t, root)}: 全量 {r}, 部分 {p}')
        total_replaced += r
        total_partial += p
    print('=' * 60)
    print(f'合计全量替换 {total_replaced} 行，部分替换 {total_partial} 行')
    if dry_run:
        print('（dry-run，未写入）')


if __name__ == '__main__':
    main()
