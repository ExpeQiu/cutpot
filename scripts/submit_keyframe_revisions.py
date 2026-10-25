#!/usr/bin/env python3
"""
提交 13 张即梦关键帧修订 + 1 张 S10 额外参考
按 待批准关键帧修订.md 列表
"""
import json
import subprocess
import sys
from pathlib import Path
from datetime import datetime

DELIVERY = Path("/Users/qiubin/Documents/cutpot/storyboard/108秒分镜图/交付版")
OUTPUT   = Path("/Users/qiubin/Documents/cutpot/storyboard/108秒全片有声/修订帧")
LOG_DIR  = Path("/Users/qiubin/Documents/cutpot/logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)

# 13 张关键帧修订（按 MD 文件顺序）
REVISIONS = [
    ("S06", "S06_开阔处跳绳.png",
     "保留所有角色身份、跳绳动作、绳体形态与场景不变。只将画面中跳绳女孩的下装从长裤改为与统一校服一致的宝蓝运动短裤（两侧白条），其他角色服装保持原样。"),
    ("S10", "S10_门口相遇前.png",
     "保持门内外空间与走廊轴线，A在门内左侧双手握浅蓝有盖水杯准备出来，B在走廊右侧面向门口准备进门，两人之间约一米以上安全距离，完整双脚与路径清晰可见。"),
    ("S11", "S11_乐乐举手制止.png",
     "继承修订S10的站位。乐乐在画面左前景抬起一只白手掌面向两位学生双脚站稳，A与B正在停步相距约一米，水杯直立。"),
    ("S12", "S12_解释慢行规则.png",
     "继承同一门口空间。乐乐在左前景摊掌解释温和，A在门内左中握杯站稳，B在右侧等待。三人同框杯子脸脚清晰。"),
    ("S13_first", "S13_先等同学通过.png",
     "首帧：A在门洞内侧让出通道双脚停稳双手握杯，B在右侧准备通过空出的门口，乐乐在走廊左前景看着。"),
    ("S13tail_S14first", "S13_先等同学通过.png",
     "尾帧/下一镜首帧：B已完整进入教室（位于门内背景），A仍未出门（仍在门洞左侧握杯）。"),
    ("S14tail", "S14_握杯慢步出门.png",
     "尾帧：B已在教室内背景，A握杯在走廊右侧慢步准备出门，通道已空，乐乐在左前景。"),
    ("S16tail", "S16_走向楼梯.png",
     "尾帧：乐乐已沿同一走廊走至楼梯入口前停稳，米白墙浅绿墙裙延续门口，地面平整无遮挡。"),
    ("S17", "S17_发现扶手边的苗头.png",
     "楼梯平台全景，下行台阶从左上延伸至右下，右侧扶手位于下行者右手一侧。C双脚在水平平台身体靠近扶手目光沿扶手下方看，在抬腿或攀爬前停止。乐乐在平台左侧入口。"),
    ("S18", "S18_楼梯平台喊停.png",
     "同侧机位略收近，乐乐在平台左侧站稳举掌，C在扶手旁双脚落地脸转向乐乐，双人全身与平台边界可见。"),
    ("S19", "S19_扶手与台阶的用途.png",
     "乐乐在平台内侧站稳，一只手掌朝向扶手，C在平台中央认真看着，构图同时交代扶手台阶与两人双脚。"),
    ("S20_first", "S20_扶稳靠右慢下楼.png",
     "首帧：C身体右手握下行右侧扶手，双脚逐阶（一只脚在上一只脚在下一阶），左手自然。乐乐站在后方平台内侧微笑，完整脚步入画。"),
    ("S20tail", "S20_扶稳靠右慢下楼.png",
     "尾帧：同一机位同一右手扶手关系，C已慢下两级台阶，右手仍扶扶手。"),
]

# S10 额外参考申请（用 S01 教室内空间作为参考）
S10_EXTRA_REF = ("S01_阳光课间.png",
                 "教室内部空间参考（门内桌椅、墙裙、窗帘、窗户、米白墙），仅用于 S10 重绘的教室内部空间感。")

def submit(task_id, source, prompt, extra_refs=None, poll=180):
    """提交 image2image 任务"""
    OUTPUT.joinpath(task_id).mkdir(parents=True, exist_ok=True)

    images = [str(DELIVERY / source)]
    if extra_refs:
        images.extend([str(DELIVERY / ref) for ref in extra_refs])

    # 限制为 1k 720P 16:9 减少消耗（与本批次其它任务统一）
    cmd = [
        "dreamina", "image2image",
        "--images", *images,
        "--prompt", prompt,
        "--ratio", "16:9",
        "--resolution_type", "2k",
        "--session", "0",
        "--generate_num", "1",
        "--poll", str(poll),
    ]

    log_path = LOG_DIR / f"submit_{task_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"\n[{task_id}] 提交: {source} (refs: {extra_refs or '无'})")
    print(f"  prompt: {prompt[:60]}...")

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=poll + 60
        )
        stdout = result.stdout
        stderr = result.stderr

        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"=== CMD ===\n{' '.join(cmd)}\n\n=== STDOUT ===\n{stdout}\n\n=== STDERR ===\n{stderr}\n")

        # 解析 submit_id
        submit_id = None
        try:
            for line in stdout.splitlines():
                line = line.strip()
                if line.startswith("{") and "submit_id" in line:
                    data = json.loads(line)
                    submit_id = data.get("submit_id")
                    break
        except json.JSONDecodeError:
            pass

        if not submit_id:
            for line in stdout.splitlines():
                m = __import__("re").search(r"submit[_-]?id[=:\s]+(\S+)", line, __import__("re").IGNORECASE)
                if m:
                    submit_id = m.group(1).strip('",')
                    break

        # 解析状态
        status = "unknown"
        for line in stdout.splitlines():
            if "gen_status" in line:
                status = line.strip()
                break

        print(f"  submit_id: {submit_id or '未解析'}")
        print(f"  status: {status[:100] if len(status) > 100 else status}")

        return {
            "task_id": task_id,
            "source": source,
            "submit_id": submit_id,
            "status": status,
            "log": str(log_path),
        }

    except subprocess.TimeoutExpired:
        print(f"  ⚠️  TIMEOUT（{poll+60}s）")
        return {"task_id": task_id, "source": source, "submit_id": None, "status": "timeout", "log": str(log_path)}
    except Exception as e:
        print(f"  ❌  ERROR: {e}")
        return {"task_id": task_id, "source": source, "submit_id": None, "status": f"error: {e}", "log": str(log_path)}


def main():
    results = []
    print("=" * 60)
    print(f"即梦关键帧修订批量提交 - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"共 {len(REVISIONS)} 张（+ 1 张 S10 额外参考）")
    print("=" * 60)

    for task_id, source, prompt in REVISIONS:
        # S10 增加 S01 作为额外参考
        extra = [S10_EXTRA_REF[0]] if task_id == "S10" else None
        result = submit(task_id, source, prompt, extra_refs=extra)
        results.append(result)

    # 保存汇总
    summary_path = LOG_DIR / f"batch_summary_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 60)
    print(f"汇总: {summary_path}")
    success = sum(1 for r in results if r.get("submit_id"))
    print(f"成功解析 submit_id: {success}/{len(results)}")
    print("=" * 60)

    return 0 if success == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
