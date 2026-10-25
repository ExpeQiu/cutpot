"""Render literal clip captions into transparent PNG overlays for FFmpeg."""
import json
import os
from pathlib import Path
import sys


def main():
    from PIL import Image, ImageDraw, ImageFont
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    width, height = spec['width'], spec['height']
    candidates = [os.environ.get('CUTPOT_SUBTITLE_FONT'),
                  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
                  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
                  'C:/Windows/Fonts/msyh.ttc']
    font_path = next((p for p in candidates if p and Path(p).is_file()), None)
    if not font_path:
        raise ValueError('未找到中文字体，请通过 CUTPOT_SUBTITLE_FONT 指定中文 TTF / TTC 字体')
    for clip in spec['clips']:
        image = Image.new('RGBA', (width, height))
        draw = ImageDraw.Draw(image)
        for size in range(round(height * .042), round(height * .027) - 1, -1):
            font = ImageFont.truetype(font_path, size)
            lines = []
            for paragraph in clip['text'].replace('\r\n', '\n').replace('\r', '\n').split('\n'):
                line = ''
                for char in paragraph:
                    if line and draw.textlength(line + char, font=font) > width * .86:
                        lines.append(line)
                        line = char
                    else:
                        line += char
                lines.append(line)
            if len(lines) <= 3:
                break
        else:
            raise ValueError('镜头字幕过长，无法清晰显示，请拆分为更短的镜头字幕')
        line_height = round(size * 1.4)
        top = height - round(height * .065) - line_height * len(lines)
        for i, line in enumerate(lines):
            draw.text((width / 2, top + i * line_height), line, font=font,
                      anchor='mt', fill='white', stroke_width=max(1, round(size / 15)), stroke_fill='black')
        image.save(clip['file'])


if __name__ == '__main__':
    try:
        main()
    except ModuleNotFoundError:
        print('烧录字幕需要 Pillow：请使用对应 Python 安装 requirements-subtitles.txt', file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print(f'字幕图层生成失败：{exc}', file=sys.stderr)
        sys.exit(1)
