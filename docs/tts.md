# CutPot 开源配音服务

CutPot 0.6 使用 **GPT-SoVITS** 替代 Azure：工作台默认儿童参考配音，支持生成、取消、试听、下载 WAV、设为工程旁白及视频导出。没有云端密钥或按调用计费的商业 TTS 依赖。macOS / Edge 仍可在通用模式显式选择，失败不自动切换服务。

## 为什么选 GPT-SoVITS

2026-10-20 查询的官方 GitHub 页面：GPT-SoVITS 约 63.2k Star；CosyVoice 约 24.0k；F5-TTS 约 15.4k；Qwen3-TTS 约 13.9k。Star 只能说明社区关注度，不能证明儿童音质。

选择 GPT-SoVITS 是因为它支持中文、短参考录音、零样本配音与官方 HTTP API。代码为 MIT；模型与参考录音须分别遵循其使用条件。F5-TTS 的预训练权重为 CC-BY-NC，不作为本项目默认方案。

儿童声音来自用户提供的儿童原声参考录音，**不是成人声音升调**。软件不做年龄识别，界面的“儿童原声”由录音提供者确认；实际自然度、角色一致性须试听判断。没有捆绑儿童录音，也没有把成人音色标为儿童。

官方来源：
- [GPT-SoVITS 仓库及安装说明](https://github.com/RVC-Boss/GPT-SoVITS)
- [官方 api_v2.py 接口](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)
- [CosyVoice](https://github.com/QwenAudio/CosyVoice)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- [F5-TTS 许可证说明](https://github.com/SWivid/F5-TTS#license)

## 启动推理服务

CutPot 自身保持轻量 Node.js + FFmpeg 架构，模型推理运行在独立 Python 环境。当前接入官方 `api_v2.py`，不是托管服务；**安装 CutPot 不等于模型已安装或启动**。

按官方仓库的安装步骤安装 GPT-SoVITS、Python 依赖及预训练权重；Apple Silicon 可用官方 MPS 安装选项。例（在独立环境和 GPT-SoVITS 仓库内执行，具体依赖以官方版本为准）：

```sh
# 官方安装脚本需要已激活的独立 conda 环境
bash install.sh --device MPS --source ModelScope
# 在仓库根目录，使用已安装权重的推理配置
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

默认接口 `http://127.0.0.1:9880`。CutPot 和模型服务必须共用本机文件系统，模型服务需能读取 CutPot 管理的参考 WAV。本版本不支持跨机器上传参考音频，不能仅通过 SSH 转发端口就假定远端能读取本机文件。

模型型号由 GPT-SoVITS 自身的推理 YAML 配置管理；CutPot 不隐式替换权重、不加载用户未选择的声音模型。安装脚本与模型下载不由网页自动执行。此实现已用模拟模型服务和真实 FFmpeg 验证接口链路，尚未在本机部署 GPT-SoVITS 权重，不能宣称真人听感已验证。

## 工作台

1. 打开“自动配音 → 配置开源配音”。
2. 填本机推理地址，默认 `http://127.0.0.1:9880`。
3. 从素材库选择或直接导入 **3–10 秒**的参考音频。建议单人、清晰、无音乐、自然说话。长录音需先裁剪。
4. 填写录音实际说出的文字，确认录音为儿童原声，保存并检查服务。
5. 输入新文案，生成并试听，满意后下载或设为工程旁白。

参考录音转换为 32kHz 单声道 WAV，保存到数据目录 `tts-references/`；配置保存为 `gpt-sovits.json`，权限 `0600`。原文件之后移走也不会丢失参考录音。旧参考副本保留，避免影响运行中的任务。重新配置立即生效，正在运行的任务保留原参考音色。

服务检查调用 `GET /openapi.json`，确认有 `POST /tts`；这不证明权重或 GPU 已就绪，只有实际生成才能验证完整推理。检查不发送生成文案。生成失败会报错，不切换到成人或系统语音。

## cutpot-cli

```sh
cutpot-cli tts configure \
  --endpoint http://127.0.0.1:9880 \
  --reference-audio /absolute/path/child-reference.wav \
  --prompt-text '参考录音实际说出的文字。' \
  --age-group child

cutpot-cli tts config --json
cutpot-cli tts providers --json
cutpot-cli tts voices --provider gpt-sovits --category child --json

cutpot-cli tts generate --provider gpt-sovits --target child \
  --text '大家好，我们一起学习吧。' --speed 0.95 \
  -o /absolute/path/narration.wav

# 生成后直接设为工程旁白；配音不能超出当前成片时长
cutpot-cli tts generate --provider gpt-sovits --target child \
  --file script.txt --attach
cutpot-cli export -o /absolute/path/film.mp4
```

参考声音 ID 为 `reference`，语气继承参考录音，当前风格仅支持 `neutral`。语速 `0.5–2` 使用模型 `speed_factor`。长文案由官方 `cut5` 按标点拆分，建议先用短句试听，再按镜头或段落生成以便调整。

CLI 兼容旧脚本，未指定 provider 时仍默认 macOS（可用 `CUTPOT_TTS_PROVIDER=gpt-sovits` 修改）。儿童模式必须显式使用 `--provider gpt-sovits --target child`；不允许 `child-bright` / `child-soft` 变调。通用模式仍保留旧效果，并明确标为调音效果。

## API

- `GET /api/tts/config`：读取本机 GPT-SoVITS 配置。
- `PUT /api/tts/config`：保存 `{endpoint,referenceAudio,promptText,ageGroup}`；工作台也可用 `referenceAssetId` 指定音频素材。
- `GET /api/tts/providers`：服务列表和可连接状态。
- `GET /api/tts/voices?provider=gpt-sovits&category=child`：参考声音目录。
- `POST /api/tts`：创建配音任务。
- `GET /api/tts/jobs`、`GET /api/tts/jobs/:id`、`POST /api/tts/jobs/:id/cancel`：进度与取消。

生成使用 JSON POST（文案不拼进 shell 或 URL），返回 WAV 经 FFmpeg 转成 48kHz PCM 单声道并校验。默认任务最长 10 分钟。取消会中断 HTTP 请求，但上游模型进程可能仍在完成当前批次；不宣称其 GPU 计算已经停止。

所有配置 API 沿用仅本机访问与 Origin 检查。推理端点仅允许本机 HTTP，不接受外部 URL、凭据或重定向。配置与参考原文保留在本机，不写入工程 JSON。

## 其他通用服务

macOS：`cutpot-cli tts generate --provider macos --text '你好' -o voice.wav`。

Edge：可选在线通用配音，文案发送给 Microsoft 服务，不用于儿童参考模式。`requirements-tts.txt` 固定 edge-tts 版本；`CUTPOT_EDGE_TTS` 可指定可执行文件，否则优先使用项目 `.cutpot/tts-runtime/bin/edge-tts`，最后使用 PATH。在线可用性须实际生成验证。

Azure 的界面、配置 API、CLI 参数与合成调用已移除；旧 Azure 配置文件不会被加载或使用。

## 多角色台词（0.7）

每个角色保存独立的 ID、名称、儿童/成人类型、参考音频和录音原文，角色音色库在同一本机工作台的不同工程、配音任务之间复用。新建角色不会覆盖其他角色；修改已有角色时使用相同角色 ID。旧版单参考配置自动作为 `reference` / 默认角色读取。

工作台“自动配音 → 配音方式 → 多角色台词”：逐段选择说话角色、填写台词，可指定起点和时长上限。点击“管理角色音色”可新建或更新角色，例如乐乐、同学、老师、旁白。儿童与成人角色可以在同一剧本交替发言，各自使用原参考音色，不使用全局儿童/成人模式替换角色。

```sh
cutpot-cli tts configure --character-id lele --character-name 乐乐 \
  --reference-audio /absolute/path/lele.wav --prompt-text '乐乐录音原文。' --age-group child
cutpot-cli tts configure --character-id teacher --character-name 老师 \
  --reference-audio /absolute/path/teacher.wav --prompt-text '老师录音原文。' --age-group adult
# 单角色任务直接指定角色 ID
cutpot-cli tts generate --provider gpt-sovits --voice lele --target child \
  --text '大家好，我是乐乐。' -o lele-line.wav
# 多角色任务，输出一个可直接用于视频导出的完整音轨
cutpot-cli tts generate --dialogue dialogue.json -o dialogue.wav --attach
```

`dialogue.json`：

```json
{
  "lines": [
    {"characterId":"lele", "text":"老师，我们应该怎么做？", "start":0, "duration":4},
    {"characterId":"teacher", "text":"先站稳，再慢慢往前走。", "start":4.5, "duration":5},
    {"characterId":"lele", "text":"我明白了！"}
  ]
}
```

`start` 是成片中的秒数；留空时接在上一段指定时长（或实际配音时长）之后，再留 0.2 秒停顿。`duration` 是该段占用时段及配音上限；配音短于该时段时保留静音，超出则整项任务失败并清理未完成音频，不截词或自动加速。明确指定的起点可重叠，适用于不同角色同时说话；无起点的台词按填写顺序排列。

每项任务最多 200 段、10000 字符，角色最多 100 个。任务开始时固定角色配置快照，生成中修改角色不会改变该任务后续台词的音色。生成的素材记录每段角色 ID、名称、文字、实际起点和时长；试听、下载、挂载旁白和最终视频导出沿用同一条完整 WAV。视频字幕仍由现有镜头字幕独立管理，不会从台词自动覆盖。

`PUT /api/tts/config` 新增可选 `characterId`、`characterName`；`GET /api/tts/config` 包含 `characters`。`POST /api/tts` 支持上述 `lines`。儿童/成人分类仍由参考录音提供者确认，程序不推断年龄。真实声音区分度、自然度和角色一致性仍需实际模型和各角色参考录音试听；测试中的不同频率音频仅用于验证路由与时间对齐，不代表真人配音效果。
