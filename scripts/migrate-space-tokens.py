# -*- coding: utf-8 -*-
"""
间距 Token 迁移脚本（v18）
将页面级硬编码 margin/padding/gap 的 4rpx 递进值替换为 var(--space-*) Token。

映射表（4rpx 递进全阶梯）：
  4  -> --space-0-5
  8  -> --space-1
  12 -> --space-1-5
  16 -> --space-2
  20 -> --space-2-5
  24 -> --space-3
  28 -> --space-3-5
  32 -> --space-4
  40 -> --space-5
  48 -> --space-6

规则：
- 单值/多值（margin: 16rpx 0）中所有 rpx 值都在映射表内 -> 整行替换为 var() 序列
- 混有非阶梯值（6/10/14/18/22/2/100rpx 等微调值）-> 部分替换：可映射的值换 Token，非阶梯值保留原值
- 已是 var() 引用的行天然不匹配数字模式，自动跳过
- 不处理 app.wxss（Token 定义处，避免误伤）
"""
import os
import re
import sys

# 4rpx 递进映射（value -> token）
MAPPING = {
    4: 'var(--space-0-5)',
    8: 'var(--space-1)',
    12: 'var(--space-1-5)',
    16: 'var(--space-2)',
    20: 'var(--space-2-5)',
    24: 'var(--space-3)',
    28: 'var(--space-3-5)',
    32: 'var(--space-4)',
    40: 'var(--space-5)',
    48: 'var(--space-6)',
}

# margin-X: / padding-X: / gap: 属性行（行内任意位置，支持单行多属性如 .container { padding: 24rpx; }）
ATTR_RE = re.compile(r'(margin|padding|gap)(?:-[a-z]+)?:\s*([^;}]+)')
# 值 token 拆分（16rpx / 0 / auto / var(...) / calc(...)）
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
        # 行内所有 margin/padding/gap 属性匹配
        for m in reversed(list(ATTR_RE.finditer(line))):
            attr, value = m.group(1), m.group(2)
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
                    # 0 / auto / var(...) / calc(...) / % 等，保留
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
    print(f'{"[DRY-RUN] " if dry_run else ""}间距 Token 迁移')
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
