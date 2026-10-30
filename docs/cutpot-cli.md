# cutpot-cli

CutPot 的本地命令行入口，复用工作台的素材库、工程验证和 FFmpeg 渲染。Node.js 22+，PATH 中需要 ffmpeg、ffprobe 与 libx264。没有 npm 依赖；剪辑合成使用本地 FFmpeg，创作工作流可调用已有媒体生成服务。

已增加自动配音：`cutpot-cli tts generate --text "你好" -o voice.wav`。默认本地语音；音色、可选在线服务、任务查询与旁白关联见 [TTS 使用手册](tts.md)。视频／图片生成服务不受影响。

## 安装与检查

在本项目目录运行：

```sh
npm link --offline --ignore-scripts --no-audit --no-fund
cutpot-cli --version
cutpot-cli doctor
cutpot-cli --help
```

也可直接使用 `node /Users/qiubin/Documents/cutpot/bin/cutpot-cli.js --help`。全局命令通过符号链接绑定项目，移动项目后需要重新执行 npm link。

## 服务和数据目录

```sh
cutpot-cli start
cutpot-cli status
cutpot-cli stop
```

`start` 后台运行，`serve` 前台运行。编辑、合成、导出命令在服务未启动时自动启动。默认 URL 为 http://127.0.0.1:4317，默认数据目录为安装项目内的 `.cutpot/`，与调用命令时所在目录无关；服务日志保存在数据目录的 `server.log`。

需要隔离工程和素材时使用独立端口与目录：

```sh
cutpot-cli start --port 4318 --data ./my-film-data
cutpot-cli --url http://127.0.0.1:4318 status
```

也可设置 `CUTPOT_URL`。`CUTPOT_DATA` 仅在启动新服务时决定数据目录；已运行服务不会因此切换目录。同端口指定其他目录时会报错。服务只允许本机 HTTP；停止运行中的导出任务需要 `stop --force`。

## 分镜图与首尾帧视频工作流

CLI 复用 `/storyboard`、`/videos` 页面的同一工作流，支持脚本拆分、共用参考图、生成设置、分镜提示词、图片候选选择、首尾帧视频生成、检查结论和送入剪辑。默认 mock；真实图片用 Dreamina，视频默认 AutoDL，也可设置 `videoProvider: "dreamina"`。N 张有序分镜图自动组成 N−1 个首尾帧片段。

```sh
cutpot-cli workflow show --json
# split.json: {"action":"split","script":"人物进教室。\n\n人物走出教室。","count":2}
cutpot-cli workflow apply ./split.json --json
cutpot-cli workflow generate image all --json
# 从上一步 jobs 数组取 ID；生成只排队，必须等待完成
cutpot-cli workflow wait IMAGE_JOB_ID_1 IMAGE_JOB_ID_2 --timeout 600 --json
cutpot-cli workflow show --json
cutpot-cli workflow generate video all --json
cutpot-cli workflow wait VIDEO_JOB_ID --timeout 1200 --json
cutpot-cli workflow handoff --json
cutpot-cli export -o ./output/film.mp4
```

`workflow generate image|video all|ID...` 可批量或按完整分镜／片段 ID 生成，返回本次新增任务。`workflow wait` 只等待指定任务；失败、取消、中断或超时返回非零退出码。超时不取消外部任务，Ctrl+C 结束本地等待；通过 `workflow show` 查看状态，避免重复付费提交。历史任务及版本由现有工作流持久化。

`workflow apply FILE.json` 每次执行一个操作，返回更新后的工作流。以下各行是独立操作文件示例；ID 从 `workflow show` 或素材导入结果取得：

```json
{"action":"script","script":"完整脚本","style":"统一画面风格"}
{"action":"references","assetIds":["IMAGE_ASSET_ID"]}
{"action":"settings","settings":{"mode":"mock","ratio":"16:9","resolution":"2k","candidates":1,"videoProvider":"autodl"}}
{"action":"shot","id":"SHOT_ID","title":"开场","description":"原文","prompt":"画面要求","negativePrompt":"多余文字"}
{"action":"segment","id":"SEGMENT_ID","prompt":"从首帧过渡到尾帧的动作与镜头","duration":5}
{"action":"attach","kind":"image","id":"SHOT_ID","assetId":"IMAGE_ASSET_ID"}
{"action":"select-version","kind":"image","id":"SHOT_ID","versionId":"VERSION_ID"}
{"action":"review","id":"SEGMENT_ID","review":"approved"}
{"action":"move-shot","id":"SHOT_ID","direction":"up"}
{"action":"stop-queue"}
{"action":"resume","id":"INTERRUPTED_JOB_ID"}
```

还支持 `add-shot`、`restore`（历史 ID）、`attach`/`select-version` 的 `kind:"video"`，以及 `review:"pending"|"rejected"`。导入参考图片先执行 `assets import FILE`。`shot` 操作会整体设置四个文本字段，需同时提供以免清空；`settings` 同样需要完整设置对象。重新拆分已有分镜需在 split 操作中明确写 `replace:true`，旧分镜进入历史。

真实生成前用 settings 操作将 mode 改为 `live`，每次提交还必须显式添加 `--authorize-live`：

```sh
cutpot-cli workflow generate image all --authorize-live --json
cutpot-cli workflow generate video SEGMENT_ID --authorize-live --json
```

操作文件中的 `authorizeLive:true` 不能替代命令行授权。真实视频禁止使用模拟帧，必须先生成或导入正式首尾图片。片段时长遵循现有工作流 1–10 秒范围，选择 Dreamina 时还须满足至少 4 秒。模拟视频只是首尾图片淡化，不代表真实模型质量。

所有写操作使用读取时的项目 ID 和 revision 检查，不自动重试冲突。需要绑定先前快照时，可在操作文件中显式提供 `projectId`、`revision`；handoff 还支持 `editorRevision`。图片版本或片段参数变更会将已有视频标为待更新；过期或已拒绝视频不能送入剪辑。浏览器有未保存输入时避免并行修改，CLI 修改后刷新页面。

## 快速合成，不改变当前时间线

```sh
# 按提供的顺序拼接；视频默认取全部完整帧，图片默认 3 秒
cutpot-cli compose ./shot_01.mp4 ./shot_02.mp4 ./ending.png -o ./output/film.mp4

# 每个镜头 3 秒；视频不足 3 秒则报错，不自动重复
cutpot-cli compose ./shot_01.mp4 ./shot_02.mp4 \
  --duration 3 --resolution 1280x720 --fps 25 \
  --narration ./voice.wav --music ./bgm.mp3 --music-volume 0.12 \
  -o ./output/film.mp4
```

默认静音源视频；`--keep-audio` 保留。旁白从成片开头播放，超出成片的部分在导出时截断，音乐循环至结尾并淡出。合成会把源文件导入共享素材库，但不替换当前工程时间线。`compose` 的镜头参数默认硬切；工作台工程支持倍速与四种接缝转场，可在浏览器编辑后使用 `export` 导出。首次生成配音并通过 `--attach` 设置旁白时仍要求长度不超过成片。

成功后得到 `film.mp4`、`film.srt`、`film.project.json`、`film.report.json`。字幕是独立 SRT，不烧录到视频。默认拒绝覆盖任意一个输出，明确添加 `--force` 才会覆盖。

## 按 JSON 清单裁切、排序和加字幕

创建 `film.json`，素材路径相对这份清单解析，也支持绝对路径：

```json
{
  "name": "教育短片",
  "resolution": "1920x1080",
  "fps": 25,
  "narration": "./voice.wav",
  "music": "./bgm.mp3",
  "musicVolume": 0.12,
  "clips": [
    {
      "file": "./shot_01.mp4",
      "title": "开场",
      "sourceIn": 0.5,
      "duration": 3,
      "subtitle": "大家好，欢迎来到今天的故事。",
      "muted": true
    },
    {
      "file": "./ending.png",
      "duration": 5,
      "subtitle": "你会怎么做？"
    }
  ]
}
```

```sh
cutpot-cli capabilities --json
cutpot-cli schema manifest --json
cutpot-cli validate ./film.json --json
cutpot-cli render ./film.json --dry-run --json
cutpot-cli render ./film.json -o ./output/film.mp4 --json
```

`validate` 与 `render --dry-run` 只读取本机文件，不导入素材、不改工作台、不启动渲染。`validate` 报告缺文件、时长越界等问题；`--dry-run` 额外返回帧量化后的区间、总时长与警告项。

`sourceIn`（或 `in`）为源入点；`duration` 按项目帧率量化；省略时视频取入点之后的完整帧，图片取 3 秒。清单支持 `locked` 元数据。`resolution` 支持 1920x1080、1280x720、1080x1920；也可写 `width` / `height`。`fps` 支持 24 / 25 / 30。

`render` 的清单含文件路径，而 `project save` 的工程快照含素材 ID；二者用途不同，不混用。这两种渲染方式都不会提交 AI 生成任务；生成请使用 workflow 命令。

## 编辑当前工作台工程

```sh
cutpot-cli project save ./backup.json
cutpot-cli project new --name "我的影片" --resolution 1920x1080 --fps 25 --force
cutpot-cli assets import ./shot_01.mp4 ./shot_02.mp4 ./voice.wav ./bgm.mp3 --json
cutpot-cli assets list

# ASSET 可使用素材 ID 或唯一文件名
cutpot-cli clip add shot_01.mp4 --in 0.5 --duration 3 --subtitle "开场旁白"
cutpot-cli clip add shot_02.mp4 --duration 4
cutpot-cli clip list
cutpot-cli clip edit 1 --title "新的开场" --subtitle "调整后的字幕"
cutpot-cli clip edit 2 --asset shot_01.mp4 --in 1 --duration 2
cutpot-cli clip move 2 --to 1
cutpot-cli clip duplicate 1
cutpot-cli clip remove 2
cutpot-cli arrange

cutpot-cli audio set --narration voice.wav --music bgm.mp3 --music-volume 0.1
cutpot-cli export -o ./output/current.mp4
cutpot-cli project save ./current.json
cutpot-cli project open ./backup.json --force
```

镜头支持序号（从 1 开始）或完整镜头 ID；ID 在重新排序后保持稳定。素材文件名重复时必须使用完整素材 ID。`clip add --at N` 指定插入位置。

`clip edit 1 --lock` 锁定，`clip edit 1 --unlock` 解锁。锁定时只能单独解锁，其他编辑会被拒绝；移动、插入、复制和删除若会移动锁定镜头也会被拒绝。`arrange` 对未锁定位置按 `shot_01`／`分镜01` 数字排序。

新建／打开工程会替换当前时间线，非空时需要 `--force`。保存的工程 JSON 引用本机素材库，不是跨机器的工程打包文件。CLI 写入使用工程版本校验，读取后若被其他命令／页面修改则返回冲突，不自动覆盖。浏览器采用内存时间线，CLI 修改后请刷新工作台；避免在浏览器存在未保存编辑时并行修改。

## 任务、脚本与退出码

```sh
cutpot-cli export --no-wait --json
cutpot-cli jobs --json
cutpot-cli job TASK_ID --json
cutpot-cli job wait TASK_ID --json
cutpot-cli cancel TASK_ID
cutpot-cli download TASK_ID -o ./output/film.mp4
```

`--no-wait` 仅提交，不与 `-o`、`--force`、`--timeout` 同用；随后用 `job wait ID` 等待结果，再用 `download` 取文件。同步导出默认一直等待；`--timeout 600` 超时后请求取消，Ctrl+C 也请求取消。任务列表保留本次服务会话；已完成任务文件保存在 `.cutpot/exports/<ID>/`，重启后仍可按 ID 下载。

`--json` 下 stdout 只输出一个 JSON 值，进度与诊断日志写 stderr。成功退出码 0，参数错误、渲染失败、文件冲突等为 1，同步等待时 Ctrl+C 为 130。错误 JSON 为 `{"error":"原因","code":"CODE","retryable":false}`，清单问题可含 `clip` / `field`。

`doctor` 除 FFmpeg 外还会报告字幕 Python/Pillow 与 TTS 就绪状态；`ok` 仍以渲染依赖为准。

```sh
cutpot-cli compose ./a.mp4 ./b.mp4 -o ./film.mp4 --json > result.json
```

引号、中文和空格路径通过参数数组传递，不经过 shell 拼接。源素材不覆盖；导入副本、缓存和历史导出暂不自动清理。图片／视频生成的默认服务偏好不因本 CLI 改变。
