#!/usr/bin/env python3
"""
字号 Token 全量迁移脚本（v17）
将硬编码 font-size 值替换为 --fs-* Token 引用。

映射规则：
  52 → --fs-hero
  44 → --fs-mega（大图标归入 mega）
  40 → --fs-mega
  36 → --fs-display
  34 → --fs-display（品牌栏特例并入 display）
  32 → --fs-heading
  30 → --fs-emphasis
  28 → --fs-subhead
  27 → --fs-subhead（特例并入）
  26 → --fs-label
  24 → --fs-body
  22 → --fs-caption
  21 → --fs-caption（特例并入）
  20 → --fs-micro
  18 → --fs-badge
  16 → --fs-badge（特例并入）

用法：python migrate-font-tokens.py [--dry-run]
"""
import re
import sys
import os
from pathlib import Path

# rpx 值 → Token 名
MIGRATION_MAP = {
    '52': '--fs-hero',
    '44': '--fs-mega',
    '40': '--fs-mega',
    '38': '--fs-display',  # 英雄名特例，并入 display（36rpx 最近邻）
    '36': '--fs-display',
    '34': '--fs-display',
    '32': '--fs-heading',
    '30': '--fs-emphasis',
    '28': '--fs-subhead',
    '27': '--fs-subhead',
    '26': '--fs-label',
    '24': '--fs-body',
    '22': '--fs-caption',
    '21': '--fs-caption',
    '20': '--fs-micro',
    '18': '--fs-badge',
    '16': '--fs-badge',
}

# 匹配 font-size: Nrpx 或 font-size:Nrpx（含可选空格）
PATTERN = re.compile(r'font-size:\s*(\d+)rpx')

# 不迁移的文件（Token 定义本身、node_modules、miniprogram_npm）
SKIP_PATTERNS = ['node_modules', 'miniprogram_npm']

def migrate_file(filepath, dry_run=False):
    """迁移单个文件，返回 (替换数, 详情列表)"""
    try:
        content = Path(filepath).read_text(encoding='utf-8')
    except Exception as e:
        return 0, [f'  ERROR reading: {e}']

    details = []
    replace_count = 0

    def replacer(match):
        nonlocal replace_count
        value = match.group(1)
        if value in MIGRATION_MAP:
            token = MIGRATION_MAP[value]
            replace_count += 1
            details.append(f'  {value}rpx → var({token})')
            return f'font-size: var({token})'
        else:
            details.append(f'  ⚠️  UNMAPPED: {value}rpx (skipped)')
            return match.group(0)

    new_content = PATTERN.sub(replacer, content)

    if not dry_run and replace_count > 0:
        Path(filepath).write_text(new_content, encoding='utf-8')

    return replace_count, details


def main():
    dry_run = '--dry-run' in sys.argv
    project_root = Path(__file__).parent.parent

    # 收集所有 .wxss 文件
    wxss_files = []
    for ext in ['*.wxss']:
        for f in project_root.rglob(ext):
            if any(skip in str(f) for skip in SKIP_PATTERNS):
                continue
            wxss_files.append(f)

    wxss_files.sort()

    total_replaced = 0
    total_unmapped = 0
    file_stats = []

    for filepath in wxss_files:
        rel = filepath.relative_to(project_root)
        count, details = migrate_file(filepath, dry_run)
        if count > 0 or any('UNMAPPED' in d for d in details):
            file_stats.append((rel, count, details))
            total_replaced += count
            total_unmapped += sum(1 for d in details if 'UNMAPPED' in d)

    # 输出报告
    print(f'=== 字号 Token 迁移报告 ===')
    print(f'模式: {"DRY RUN（不写入）" if dry_run else "WRITE（实际替换）"}')
    print(f'扫描文件: {len(wxss_files)}')
    print(f'受影响文件: {len(file_stats)}')
    print(f'总替换数: {total_replaced}')
    print(f'未映射值: {total_unmapped}')
    print()

    for rel, count, details in sorted(file_stats, key=lambda x: -x[1]):
        print(f'📄 {rel} ({count} 处)')
        for d in details[:5]:
            print(f'   {d}')
        if len(details) > 5:
            print(f'   ... 共 {len(details)} 处')
        print()


if __name__ == '__main__':
    main()
