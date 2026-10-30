# CutPot

0.9 新增视频创作流水线：**分镜图创作 → 首尾帧视频 → 剪辑导出**。打开工作台后可在顶部切换三个独立页面。默认模拟模式；真实图片接入即梦 CLI，视频接入 AutoDL 首尾帧模式。详见[流水线使用说明](docs/视频创作流水线.md)。

本地运行的分镜自动组片工作台。导入 AI 生成的视频与图片，按分镜编排、裁切和替换，添加旁白、音乐与字幕，使用 FFmpeg 导出 MP4。

## 命令行

```sh
npm link --offline --ignore-scripts --no-audit --no-fund
cutpot-cli doctor
cutpot-cli compose ./shot_01.mp4 ./shot_02.mp4 -o ./film.mp4
cutpot-cli render ./film.json -o ./film.mp4 --json
cutpot-cli --help
```

`cutpot-cli` 可管理服务、导入素材、裁切／替换／排序镜头、编辑字幕、配置音轨与导出。`compose` / `render` 按文件或清单合成，保留工作台当前时间线；服务未启动时自动启动。完整说明见 [CLI 使用手册](docs/cutpot-cli.md)。

## 启动

需要 Node.js 22+，以及 PATH 中的 `ffmpeg`、`ffprobe`（含 libx264 编码器）。无需安装 npm 依赖。

```sh
npm start
```

打开 http://127.0.0.1:4317。服务仅监听本机。修改端口可使用 `PORT=4318 npm start`。

## 使用

1. 点击“载入乐乐示例”，体验现有分镜构成的 60 秒静态预演；或批量导入视频、图片和音频。
2. 素材右侧 `+` 将画面添加到时间线；音频添加到旁白或音乐轨，也可在右侧指定。
3. 选中镜头，拖动两端截取，或在右侧调整入出点、时长和 0.25 至 4 倍速。S 分割，I / O 截到播放头；接缝处添加转场，“插入画面”放入图片或视频。支持吸附、逐帧定位和撤销重做。详见[时间轴剪辑说明](docs/时间轴剪辑.md)。锁定镜头后，自动排序保留该位置，手动编辑也需先解锁。
4. “按分镜编号编排”识别 `shot_01`、`分镜01` 等名称。首版为确定性排序，不含模型语义分析。拖动镜头或使用前移／后移可调整顺序，不能跨越锁定镜头。
5. 点击“导出视频”，完成后下载 MP4 和 SRT。默认勾选“将字幕显示在视频画面中”，导出可直接播放的字幕视频，同时保留独立 SRT；也可取消勾选。未添加音频的项目导出为带静音轨的影片。

工程自动保存到 `.cutpot/project.json`，素材复制到 `.cutpot/media/`，导出到 `.cutpot/exports/<任务ID>/`。现有示例分镜直接引用原文件。工程 JSON 只保存素材引用，重新打开需要同一素材库，不是跨设备的自包含工程包。

三个页面顶部均可“保存工程”和“导入工程”，统一保存分镜、视频版本与剪辑时间轴，兼容旧版工程。详见[工程保存与导入](docs/工程保存与导入.md)。

导出任务使用独立的时间线快照，不受后续编辑影响。支持进度、取消、失败提示和重复导出时复用完成的镜头缓存；缓存和导出文件暂由用户手动清理。任务列表仅保留本次服务会话，输出文件持续保留。

## 验证

```sh
npm run check
npm test
```

测试覆盖帧时钟、字幕时码、锁定排序、输入校验、本地 API，以及真实 FFmpeg 混合素材／混音导出、完整解码、帧数与缓存复用。没有 FFmpeg 时，渲染集成测试会明确跳过。

## 当前边界

- 先提供本地浏览器工作台，尚未打包 Electron 桌面应用。
- 支持硬切、叠化、淡入黑场、淡入白场和向左擦除；视频不足时报错，不自动重复或生成补镜头。
- 素材可导入不等于浏览器可解码。建议预览使用 H.264 MP4；MOV／MKV 等素材能否预览取决于浏览器编码支持，导出由 FFmpeg 负责。
- 旁白从 0 秒开始，音乐循环并在导出结尾淡出；首版固定音量混音，未实现自动语音识别、语义匹配、压低音乐包络与精确波形。
- 片段逐个渲染并缓存，再统一拼接。30—60 分钟项目的性能和章节边界仍需专项压测；尚未承诺生产规模性能。
- 首版单用户单工作台，请避免多个页面同时修改工程。默认媒体处理与配音在本机进行；明确选择 Edge 在线 TTS 时，配音文字会发送到该服务。

完整产品方向见 [产品规划](docs/自动剪辑软件产品规划.md)。

## 自动配音（TTS）

工作台左侧新增“自动配音”：输入文案，选择音色和语速，生成后可试听、下载 WAV，或设为当前工程旁白。不会自动改变镜头时长；配音长于成片时会阻止设置。

```sh
cutpot-cli tts providers
cutpot-cli tts voices --provider macos
cutpot-cli tts generate --text "你好，欢迎来到今天的故事。" --voice Tingting -o voice.wav
cutpot-cli tts generate --file script.txt --speed 1.1 --attach
cutpot-cli compose shot_01.mp4 shot_02.mp4 --narration voice.wav -o film.mp4
```

默认使用 macOS 本地语音，不联网。可显式选择 `--provider edge` 使用已安装的 `edge-tts`；该模式将文字发送到 Microsoft Edge 在线语音服务，不自动切换或回退。完整说明见 [TTS 使用手册](docs/tts.md)。

已用高 Star 开源项目 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 替代 Azure。工作台默认儿童参考配音：配置本机推理服务，导入 3–10 秒儿童原声录音及原文，然后生成、试听、下载或设为工程旁白。不使用成人升调冒充儿童声音；自然度需结合模型与参考录音试听确认。

CLI：`cutpot-cli tts configure --reference-audio /absolute/path/ref.wav --prompt-text '参考原文' --age-group child`，随后 `cutpot-cli tts generate --provider gpt-sovits --target child --text '你好。' -o voice.wav`。

推理模型需独立安装与启动；CutPot 接入本机官方 `api_v2.py`，不需要 Azure 密钥。部署步骤、接口与使用限制见 [TTS 文档](docs/tts.md)。

## 文件整理与归档

项目文件入口：

- [视频制作项目与分镜](storyboard/README.md)：乐乐、曹冲称象的方案、素材和制作记录。
- [成片与交付入口](exports/README.md)：成片、字幕、工程快照及导出报告。
- [创作参考素材](references/README.md)：人物、校服、学校原始参考图。
- [使用文档](docs/README.md)：CLI、配音、产品规划；截图统一收纳在 `docs/images/`。
- `src/`、`public/`、`bin/`、`test/`：应用源码、前端、命令入口与测试。
- `skills/`：项目内的视频制作技能；`scripts` 为既有一次性脚本的兼容链接。
- `.cutpot/`：工作台工程、素材库、缓存、配音配置和自动导出，保留原路径。

过程文件按类别收纳在 [2026-10-20 归档目录](archive/2026-10-20/README.md)，包含历史候选、修图记录、提交日志和旧 ZIP 包。归档目录有逐文件校验清单及恢复脚本；原脚本所需目录保留兼容软链接。当前制作、交付素材与工作台运行数据仍在原位置。

本轮参考图与截图收纳记录见[目录整理补充](archive/2026-10-20/目录整理补充/README.md)，含逐文件校验清单和恢复脚本。

0.7 新增多角色配音：为乐乐、同学、老师、旁白分别保存角色音色；每段台词指定角色与时间起点，生成完整对话 WAV。CLI 用 `tts configure --character-id lele --character-name 乐乐 ...` 保存角色，再用 `tts generate --dialogue dialogue.json -o dialogue.wav --attach` 合成。角色可跨任务复用，详见 [多角色台词](docs/tts.md#多角色台词07)。


## 画面字幕导出（0.8）

工作台“导出视频”默认勾选字幕烧录。字幕按镜头区间显示，底部居中、白字黑边，自动换行至最多三行；过长会提示拆分。无字幕镜头不显示文字。预览开关仅控制预览，最终导出由导出面板勾选项决定。

CLI：`cutpot-cli export --burn-subtitles -o film.mp4`。`render` 和 `compose` 同样接受 `--burn-subtitles`，内容来自工程/清单的镜头 `subtitle` 字段；不会自动识别语音生成字幕。未传该参数的旧脚本继续输出无烧录版本。API 在 `POST /api/render` 工程对象中传 `burnSubtitles: true`。

烧录使用 Python Pillow 生成透明中文字层，再由 FFmpeg 合入画面，不依赖 FFmpeg 的 libass。需 Python 3 + `requirements-subtitles.txt`，macOS 自动使用系统 Arial Unicode；Linux 可安装 Noto CJK 字体，其他字体用 `CUTPOT_SUBTITLE_FONT=/absolute/font.ttf` 指定；`CUTPOT_SUBTITLE_PYTHON` 可指定 Python 可执行文件。没有依赖或字体时明确报错，不会悄悄导出缺字幕的视频。

烧录后的文字成为画面的一部分，播放器无需另行加载字幕。导出仍附带 SRT、工程快照和报告；报告中的 `burnSubtitles` 标识是否选择烧录。
